/**
 * HTTP client for the Qwen web API.
 *
 * Envelope shape used by every endpoint:
 *   { success: boolean, request_id: string, data: any }
 * `data` is returned unwrapped; `success: false` becomes a QwenError.
 */
import { Session, baseHeaders } from "./session.js";
import { readSSE } from "./sse.js";
import { routeUrl } from "./routes.js";

export class QwenError extends Error {
  constructor(message, { status, code, details, url } = {}) {
    super(message);
    this.name = "QwenError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.url = url;
  }
}

/** Raised when the body is the anti-bot interstitial instead of API data. */
export class AntiBotError extends QwenError {
  constructor(url, marker) {
    super("Anti-bot challenge in response body", { code: "AntiBotChallenge", url, details: marker });
    this.name = "AntiBotError";
    this.marker = marker;
  }
}

/**
 * The gateway answers HTTP 200 on the wire and reports the real status in
 * `x-actual-status-code`, so `res.status` never reveals the 401. Returns
 * the effective status, falling back to the wire status when absent.
 */
export function effectiveStatus(res) {
  const hdr = res.headers.get("x-actual-status-code");
  const n = hdr === null ? NaN : Number(hdr);
  return Number.isFinite(n) ? n : res.status;
}

/** Markers that identify the Alibaba TMD interstitial in a response body. */
const CHALLENGE_MARKERS = ["_____tmd_____", "punishTextFetch", "x5secdata", "gridConnectGet"];

/**
 * Detect the anti-bot interstitial inside a body that claimed to be API data.
 * Returns the matched marker, or null when the body looks like normal JSON.
 * Cheap scan: only runs on bodies without a JSON content type or on
 * suspicious text, so the hot path stays untouched.
 */
export function detectChallenge(text) {
  if (typeof text !== "string" || !text) return null;
  for (const m of CHALLENGE_MARKERS) if (text.includes(m)) return m;
  return null;
}

/** Default ceiling for an SSE stream so a stalled socket cannot hang forever. */
export const DEFAULT_STREAM_TIMEOUT_MS = 60_000;

export class QwenClient {
  /**
   * @param {Session} session
   * @param {{onRetry?: Function, retries?: number}} [opts]
   */
  constructor(session = new Session(), opts = {}) {
    this.session = session;
    this.retries = opts.retries ?? 1;
    this.onRetry = opts.onRetry;
  }

  static fromDisk() {
    return new QwenClient(Session.load());
  }

  /** Low level request. Returns { status, headers, data }. */
  async raw(url, { method = "GET", body, headers = {}, stream = false, signal } = {}) {
    const finalHeaders = baseHeaders(headers);
    const cookie = this.session.header();
    if (cookie) finalHeaders.cookie = cookie;
    // Cookies alone are not enough: auth.qwen.ai answers 401 until the
    // browser's access token rides along as a Bearer header.
    if (this.session.accessToken) finalHeaders.authorization = `Bearer ${this.session.accessToken}`;

    const init = { method, headers: finalHeaders, signal, redirect: "manual" };
    if (body !== undefined) {
      finalHeaders["content-type"] = finalHeaders["content-type"] ?? "application/json";
      init.body = typeof body === "string" ? body : JSON.stringify(body);
    }

    const res = await fetch(url, init);

    // Track Set-Cookie so token refresh survives across calls.
    const sc = res.headers.getSetCookie?.() ?? [];
    if (sc.length) this.session.absorb(sc);

    const status = effectiveStatus(res);

    if (status === 401 && this.retries > 0) {
      this.retries -= 1;
      this.onRetry?.(url);
      await this.#refresh();
      return this.raw(url, { method, body, headers, stream, signal });
    }

    const ctype = (res.headers.get("content-type") || "").toLowerCase();

    if (stream) {
      // Never hand a non-SSE body to the SSE parser: the challenge page and
      // HTML error pages both arrive with status 200.
      if (!ctype.includes("text/event-stream")) {
        const text = await res.text();
        const marker = detectChallenge(text);
        if (marker) throw new AntiBotError(url, marker);
        throw new QwenError(`Expected text/event-stream, got ${ctype || "(none)"}`, {
          status,
          code: "UnexpectedContentType",
          url,
        });
      }
      if (status >= 400) {
        throw new QwenError(`HTTP ${status}`, { status, url });
      }
      return res;
    }

    const text = await res.text();

    // The interstitial ships as HTML, but it can sit behind any content
    // type; scanning costs four substring passes, so it always runs.
    const marker = detectChallenge(text);
    if (marker) throw new AntiBotError(url, marker);

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }

    if (parsed && typeof parsed === "object" && parsed.success === false) {
      const inner = parsed.data ?? {};
      throw new QwenError(inner.code ?? "RequestFailed", {
        status,
        code: inner.code,
        details: inner.details,
        url,
      });
    }
    if (status >= 400 || !res.ok) {
      throw new QwenError(`HTTP ${status}`, { status, url });
    }
    return { status, headers: res.headers, data: parsed?.data ?? parsed, requestId: parsed?.request_id };
  }

  async #refresh() {
    await fetch("https://auth.qwen.ai/api/v2/auths/refresh", {
      method: "GET",
      headers: { ...baseHeaders(), cookie: this.session.header() },
    })
      .then((r) => {
        const sc = r.headers.getSetCookie?.() ?? [];
        if (sc.length) this.session.absorb(sc);
      })
      .catch(() => {});
  }

  /** Invoke a route from the registry. */
  async call(route, args = {}, opts = {}) {
    const url = routeUrl(route, args);
    return this.raw(url, {
      method: route.method,
      body: route.body ? pick(args, Object.keys(route.body)) : undefined,
      headers: opts.headers,
      signal: opts.signal,
    });
  }

  /**
   * Invoke a streaming route, yielding SSE events.
   *
   * `opts.timeout` bounds the whole stream (default
   * DEFAULT_STREAM_TIMEOUT_MS); pass 0 to disable. The response is checked
   * for the anti-bot interstitial before the first byte is parsed, and
   * again if the challenge markers appear inside the stream.
   */
  async *stream(route, args = {}, opts = {}) {
    const url = routeUrl(route, args);
    const timeoutMs = opts.timeout === undefined ? DEFAULT_STREAM_TIMEOUT_MS : opts.timeout;

    // Bound the request + stream together so a socket that accepts the POST
    // and then never sends a byte still terminates.
    const timeoutSignal = timeoutMs > 0 && typeof AbortSignal.timeout === "function"
      ? AbortSignal.timeout(timeoutMs)
      : null;
    const canCombine = timeoutSignal && typeof AbortSignal.any === "function";
    const signal = canCombine && opts.signal
      ? AbortSignal.any([opts.signal, timeoutSignal])
      : opts.signal || timeoutSignal;

    let res;
    try {
      res = await this.raw(url, {
        method: route.method,
        body: route.body ? pick(args, Object.keys(route.body)) : undefined,
        stream: true,
        signal,
      });
    } catch (err) {
      throw this.#describeTimeout(err, timeoutSignal, timeoutMs, url);
    }

    try {
      for await (const ev of readSSE(res, { signal })) {
        if (detectChallenge(ev.data)) throw new AntiBotError(url, "_____tmd_____");
        yield ev;
      }
    } catch (err) {
      throw this.#describeTimeout(err, timeoutSignal, timeoutMs, url);
    }
  }

  /**
   * Classify an abort: only an abort caused by OUR timeout becomes
   * StreamTimeout. An abort from the caller's own `opts.signal` keeps its
   * original shape so callers can still tell "you cancelled" from "we gave up".
   */
  #describeTimeout(err, timeoutSignal, timeoutMs, url) {
    if (err instanceof QwenError) return err;
    if (err?.name !== "TimeoutError" && err?.name !== "AbortError") return err;
    if (!timeoutSignal?.aborted) return err;
    return new QwenError(`Stream timed out after ${timeoutMs}ms`, {
      code: "StreamTimeout",
      url,
    });
  }

  /** True when the session carries a valid identity. */
  async isAuthenticated() {
    try {
      const r = await this.raw("https://auth.qwen.ai/api/v2/auths/", { method: "GET" });
      // The v2 payload identifies the account as `id`; older builds used
      // `user_id`, so accept either instead of reporting guest on success.
      return Boolean(r.data && (r.data.id || r.data.user_id));
    } catch {
      return false;
    }
  }
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return Object.keys(out).length ? out : undefined;
}