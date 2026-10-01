/**
 * Session recorder.
 *
 * Modes:
 *  1. CDP  - attach to a Chrome instance you started with --remote-debugging-port
 *            and record every request/response without any MCP in the loop.
 *  2. MCP  - `ingest()` accepts entries already captured by a browser MCP
 *            (browser.network.list + browser.network.get) and folds them in.
 *
 * Output: HAR 1.2 in ./captures/<name>-<timestamp>.har
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const HAR_VERSION = "1.2";

export class Recorder {
  constructor({ name = "qwen", filter } = {}) {
    this.name = name;
    this.entries = [];
    this.filter = filter ?? defaultFilter;
    this.startedAt = Date.now();
  }

  /** Keep only what belongs to the Qwen API surface. */
  static isApiUrl(url) {
    return /https?:\/\/(chat|auth|coder|qwen)\.qwen\.ai\/api\//.test(url);
  }

  add(entry) {
    if (!this.filter(entry.url)) return false;
    this.entries.push({ ...entry, _id: this.entries.length });
    return true;
  }

  /** Fold in a batch of MCP network.get results. */
  ingest(requests, bodies = {}) {
    let kept = 0;
    for (const req of requests) {
      const b = bodies[req.id] ?? {};
      const ok = this.add({
        url: req.url,
        method: req.method,
        resourceType: req.resourceType,
        status: req.statusCode ?? req.status ?? null,
        startedAt: req.timestampMs ?? null,
        durationMs: req.durationMs ?? null,
        requestHeaders: b.requestHeaders ?? [],
        responseHeaders: b.responseHeaders ?? [],
        requestBody: b.requestBody ?? null,
        responseBody: b.responseBody ?? null,
        source: req.source ?? "mcp",
      });
      if (ok) kept += 1;
    }
    return kept;
  }

  /** Group by endpoint so you can see the surface at a glance. */
  summary() {
    const byEndpoint = new Map();
    for (const e of this.entries) {
      const key = `${e.method} ${normalise(e.url)}`;
      const cur = byEndpoint.get(key) ?? {
        count: 0,
        statuses: new Set(),
        types: new Set(),
        hasRequestBody: false,
        hasResponseBody: false,
      };
      cur.count += 1;
      if (e.status) cur.statuses.add(e.status);
      cur.types.add(e.resourceType ?? "unknown");
      if (e.requestBody) cur.hasRequestBody = true;
      if (e.responseBody) cur.hasResponseBody = true;
      byEndpoint.set(key, cur);
    }
    return [...byEndpoint.entries()]
      .map(([endpoint, v]) => ({
        endpoint,
        calls: v.count,
        statuses: [...v.statuses],
        types: [...v.types],
        hasRequestBody: v.hasRequestBody,
        hasResponseBody: v.hasResponseBody,
      }))
      .sort((a, b) => b.calls - a.calls || a.endpoint.localeCompare(b.endpoint));
  }

  toHAR() {
    return {
      log: {
        version: HAR_VERSION,
        creator: { name: this.name, version: "1.0.0" },
        pages: [],
        entries: this.entries.map((e) => ({
          startedDateTime: e.startedAt ? new Date(e.startedAt).toISOString() : new Date().toISOString(),
          time: e.durationMs ?? 0,
          request: {
            method: e.method,
            url: e.url,
            httpVersion: "HTTP/2",
            headers: (e.requestHeaders ?? []).map((h) => ({ name: h.name, value: h.value })),
            cookies: [],
            queryString: [],
            headersSize: -1,
            bodySize: e.requestBody?.length ?? 0,
            ...(e.requestBody ? { postData: { mimeType: "application/json", text: e.requestBody } } : {}),
          },
          response: {
            status: e.status ?? 0,
            statusText: "",
            httpVersion: "HTTP/2",
            headers: (e.responseHeaders ?? []).map((h) => ({ name: h.name, value: h.value })),
            cookies: [],
            content: {
              size: e.responseBody?.length ?? 0,
              mimeType: "application/json",
              ...(e.responseBody ? { text: e.responseBody } : {}),
            },
            redirectURL: "",
            headersSize: -1,
            bodySize: e.responseBody?.length ?? 0,
          },
          cache: {},
          timings: { send: 0, wait: e.durationMs ?? 0, receive: 0 },
          _resourceType: e.resourceType,
          _source: e.source,
        })),
      },
    };
  }

  save(dir = "captures") {
    mkdirSync(resolve(process.cwd(), dir), { recursive: true });
    const stamp = new Date(this.startedAt).toISOString().replace(/[:.]/g, "-");
    const file = resolve(process.cwd(), dir, `${this.name}-${stamp}.har`);
    writeFileSync(file, JSON.stringify(this.toHAR(), null, 2));
    return file;
  }
}

function normalise(url) {
  try {
    const u = new URL(url);
    // UUIDs first so `12345678-1234-...` collapses as one token, then any
    // long digit run. The query string is dropped: page=1 vs page=2 is the
    // same endpoint, and that is what the summary groups by.
    const idLike =
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d{6,}/gi;
    return u.origin + u.pathname.replace(idLike, "{id}");
  } catch {
    return url;
  }
}

function defaultFilter(url) {
  return Recorder.isApiUrl(url);
}

/**
 * Record straight from a Chrome CDP endpoint. Returns the Recorder once the
 * target has been idle for `idleMs`, or after `maxMs`.
 */
export async function recordViaCDP({ port = 9222, idleMs = 4000, maxMs = 120000, name = "qwen" } = {}) {
  const rec = new Recorder({ name });
  const listRes = await fetch(`http://127.0.0.1:${port}/json/list`);
  const targets = await listRes.json();
  const page = targets.find((t) => t.type === "page" && /qwen\.ai/.test(t.url)) ?? targets.find((t) => t.type === "page");
  if (!page) throw new Error("No page target found on the debugging port");

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const pending = new Map();
  let id = 0;

  const send = (method, params = {}) =>
    new Promise((resolve_) => {
      const msgId = ++id;
      pending.set(msgId, resolve_);
      ws.send(JSON.stringify({ id: msgId, method, params }));
    });

  await new Promise((res, rej) => {
    ws.addEventListener("open", res, { once: true });
    ws.addEventListener("error", rej, { once: true });
  });

  const bodies = new Map(); // requestId -> { req, res }
  await send("Network.enable");
  await send("Page.enable");

  ws.addEventListener("message", async (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg.result);
      pending.delete(msg.id);
      return;
    }
    const { method, params } = msg;
    if (method === "Network.requestWillBeSent") {
      bodies.set(params.requestId, {
        url: params.request.url,
        method: params.request.method,
        resourceType: params.type,
        wallTime: params.wallTime,
        requestHeaders: headerList(params.request.headers),
        requestBody: params.request.postData ?? null,
        timestampMs: params.timestamp,
      });
    } else if (method === "Network.responseReceived") {
      const b = bodies.get(params.requestId);
      if (b) {
        b.status = params.response.status;
        b.responseHeaders = headerList(params.response.headers);
      }
    } else if (method === "Network.loadingFinished") {
      const b = bodies.get(params.requestId);
      if (!b) return;
      const body = await loadBody(send, params.requestId);
      if (body) b.responseBody = body;
      rec.add({
        ...b,
        startedAt: b.wallTime ? b.wallTime * 1000 : null,
        // CDP timestamps are monotonic seconds; derive the true duration.
        durationMs:
          typeof params.timestamp === "number" && typeof b.timestampMs === "number"
            ? Math.max(0, Math.round((params.timestamp - b.timestampMs) * 1000))
            : 0,
        source: "cdp",
      });
      bodies.delete(params.requestId);
    }
  });

  // Wait until traffic goes quiet, or the deadline hits.
  const deadline = Date.now() + maxMs;
  let lastAt = Date.now();
  const tick = setInterval(() => {
    if (Date.now() - lastAt > idleMs || Date.now() > deadline) {
      clearInterval(tick);
      ws.close();
    }
  }, 500);
  const origAdd = rec.add.bind(rec);
  rec.add = (e) => {
    const ok = origAdd(e);
    if (ok) lastAt = Date.now();
    return ok;
  };

  await new Promise((r) => setTimeout(r, Math.min(maxMs, idleMs + 500)));
  clearInterval(tick);
  try {
    ws.close();
  } catch {
    /* already closed by the idle tick */
  }
  return rec;
}

async function loadBody(send, requestId) {
  try {
    const r = await send("Network.getResponseBody", { requestId });
    return r?.body ?? null;
  } catch {
    return null;
  }
}

function headerList(headers = {}) {
  return Object.entries(headers).map(([name, value]) => ({ name, value: String(value) }));
}