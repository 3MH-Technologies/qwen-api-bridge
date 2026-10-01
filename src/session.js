/**
 * Session handling for the Qwen web API.
 *
 * The web app authenticates with HttpOnly cookies, so a plain fetch client
 * needs a cookie jar. Everything stays on disk in ./.session.json and is
 * gitignored.
 */
import { readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

const SESSION_FILE = resolve(process.cwd(), ".session.json");

/** Headers the browser sends that the API expects. */
export function baseHeaders(extra = {}) {
  return {
    accept: "application/json, text/plain, */*",
    "accept-language": "en-US,en;q=0.9",
    origin: "https://chat.qwen.ai",
    referer: "https://chat.qwen.ai/",
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "x-request-id": randomUUID(),
    ...extra,
  };
}

export class Session {
  /**
   * @param {Record<string,string>} cookies
   * @param {string|null} [accessToken] Bearer token from `localStorage.token`
   *   in the browser. The web API answers 401 to cookies alone, so the token
   *   travels with every request when present.
   */
  constructor(cookies = {}, accessToken = null) {
    this.cookies = cookies;
    this.accessToken = accessToken || null;
  }

  static load() {
    if (existsSync(SESSION_FILE)) {
      try {
        const raw = JSON.parse(readFileSync(SESSION_FILE, "utf8"));
        return new Session(raw.cookies || {}, raw.accessToken || null);
      } catch {
        /* corrupt file: start empty */
      }
    }
    return new Session();
  }

  save() {
    writeFileSync(
      SESSION_FILE,
      JSON.stringify({ cookies: this.cookies, accessToken: this.accessToken }, null, 2),
      // Owner-only: the file holds live credentials.
      { mode: 0o600 }
    );
    try {
      chmodSync(SESSION_FILE, 0o600);
    } catch {
      /* Windows or unsupported fs: mode above already applied on create */
    }
    return SESSION_FILE;
  }

  setAccessToken(token) {
    this.accessToken = token || null;
    return this;
  }

  /**
   * Import the `{ token, cookieString }` blob exported from the browser page
   * (see README → جلسة المتصفح). Returns the number of cookies imported.
   */
  importSessionJson(json) {
    if (json.cookieString) this.importCookieString(json.cookieString);
    if (json.token) this.setAccessToken(json.token);
    return this.size;
  }

  /** Merge a raw `Set-Cookie` header value. */
  absorb(setCookie) {
    if (!setCookie) return;
    for (const raw of [].concat(setCookie)) {
      const [pair, ...attrs] = raw.split(";");
      const idx = pair.indexOf("=");
      if (idx < 1) continue;
      const name = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();
      const maxAge = attrs.find((a) => /max-age/i.test(a));
      if (value === "" || (maxAge && Number(maxAge.split("=")[1]) <= 0)) {
        delete this.cookies[name];
      } else {
        this.cookies[name] = value;
      }
    }
  }

  /** Import a `document.cookie` string or a full HAR-less cookie list. */
  importCookieString(str) {
    for (const part of str.split(";")) {
      const idx = part.indexOf("=");
      if (idx < 1) continue;
      this.cookies[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
    }
    return this;
  }

  header() {
    const pairs = Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`);
    return pairs.length ? pairs.join("; ") : "";
  }

  get size() {
    return Object.keys(this.cookies).length;
  }

  /** Names only — never print cookie values into logs. */
  names() {
    return Object.keys(this.cookies).sort();
  }
}