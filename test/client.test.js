import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  QwenClient,
  QwenError,
  AntiBotError,
  effectiveStatus,
  detectChallenge,
  DEFAULT_STREAM_TIMEOUT_MS,
} from "../src/client.js";
import { Session } from "../src/session.js";

function fakeFetch(responses, { onCall, refreshResponse } = {}) {
  let i = 0;
  const impl = async (url, init) => {
    onCall?.(url, init);
    const isRefresh = String(url).includes("/auths/refresh");
    const spec = isRefresh && refreshResponse
      ? refreshResponse
      : responses[Math.min(i, responses.length - 1)];
    if (!isRefresh) i += 1;
    return {
      status: spec.status ?? 200,
      ok: (spec.status ?? 200) < 400,
      headers: {
        get: (k) => {
          const key = k.toLowerCase();
          if (key === "x-actual-status-code") return spec.actualStatus ?? null;
          if (key === "content-type") return spec.contentType ?? "application/json";
          if (key === "set-cookie") return spec.setCookie ?? null;
          return null;
        },
        getSetCookie: () => (spec.setCookie ? [spec.setCookie] : []),
      },
      text: async () => spec.body ?? "",
      body: {
        getReader() {
          const enc = new TextEncoder();
          const chunks = (spec.body ?? "").match(/[\s\S]{1,64}/g) ?? [];
          let i = 0;
          return {
            async read() {
              if (i >= chunks.length) return { done: true, value: undefined };
              return { done: false, value: enc.encode(chunks[i++]) };
            },
            async cancel() {},
          };
        },
      },
    };
  };
  return impl;
}

describe("effectiveStatus", () => {
  const res = (status, hdr) => ({
    status,
    headers: { get: (k) => (k === "x-actual-status-code" ? hdr : null) },
  });
  test("prefers x-actual-status-code", () => assert.equal(effectiveStatus(res(200, "401")), 401));
  test("falls back to wire status", () => assert.equal(effectiveStatus(res(200, null)), 200));
  test("ignores garbage", () => assert.equal(effectiveStatus(res(200, "abc")), 200));
  test("uses non-200 wire status", () => assert.equal(effectiveStatus(res(503, null)), 503));
});

describe("detectChallenge", () => {
  test("flags the interstitial", () => {
    assert.equal(detectChallenge("<html>_____tmd_____/punish?x5secdata=abc</html>"), "_____tmd_____");
    assert.equal(detectChallenge('{"x5secdata":"x"}'), "x5secdata");
  });
  test("leaves normal JSON alone", () => {
    assert.equal(detectChallenge(JSON.stringify({ success: true, data: [] })), null);
    assert.equal(detectChallenge(""), null);
    assert.equal(detectChallenge(undefined), null);
  });
});

describe("errors", () => {
  test("AntiBotError is a QwenError with a stable code", () => {
    const e = new AntiBotError("https://chat.qwen.ai/api/v2/chat/completions", "x5secdata");
    assert.ok(e instanceof QwenError);
    assert.ok(e instanceof Error);
    assert.equal(e.name, "AntiBotError");
    assert.equal(e.code, "AntiBotChallenge");
    assert.equal(e.marker, "x5secdata");
  });
  test("stream timeout ceiling is exported", () => {
    assert.equal(DEFAULT_STREAM_TIMEOUT_MS, 60_000);
  });
});

describe("QwenClient.raw", () => {
  const realFetch = globalThis.fetch;
  let calls;
  let client;

  beforeEach(() => {
    calls = [];
    client = new QwenClient(new Session({ cna: "x" }, "tok"));
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("unwraps the envelope and tracks request ids", async () => {
    globalThis.fetch = fakeFetch([{ body: JSON.stringify({ success: true, request_id: "r1", data: { id: "u1" } }) }]);
    const r = await client.raw("https://chat.qwen.ai/api/v2/models/");
    assert.deepEqual(r.data, { id: "u1" });
    assert.equal(r.requestId, "r1");
    assert.equal(r.status, 200);
  });

  test("sends cookies + bearer + request id", async () => {
    globalThis.fetch = fakeFetch([{ body: "{}" }], { onCall: (u, init) => calls.push([u, init]) });
    await client.raw("https://chat.qwen.ai/api/v2/models/");
    const [, init] = calls[0];
    assert.match(init.headers.cookie, /cna=x/);
    assert.equal(init.headers.authorization, "Bearer tok");
    assert.ok(init.headers["x-request-id"]);
  });

  test("success:false raises QwenError carrying code + details", async () => {
    globalThis.fetch = fakeFetch([
      { body: JSON.stringify({ success: false, data: { code: "InvalidPassword", details: "wrong" } }) },
    ]);
    await assert.rejects(
      () => client.raw("https://auth.qwen.ai/api/v2/auths/signin", { method: "POST" }),
      (e) => e instanceof QwenError && e.code === "InvalidPassword" && e.details === "wrong"
    );
  });

  test("anti-bot body raises AntiBotError, never parses as JSON", async () => {
    globalThis.fetch = fakeFetch([
      { contentType: "text/html", body: "<html>_____tmd_____/punishTextFetch x5secdata</html>" },
    ]);
    await assert.rejects(
      () => client.raw("https://chat.qwen.ai/api/v2/chat/completions", { method: "POST" }),
      (e) => e instanceof AntiBotError && e.code === "AntiBotChallenge"
    );
  });

  test("401 in x-actual-status-code triggers exactly one refresh + retry", async () => {
    let refreshes = 0;
    globalThis.fetch = fakeFetch(
      [
        { actualStatus: "401", body: "" },
        { body: JSON.stringify({ success: true, data: { ok: true } }) },
      ],
      { onCall: (u) => String(u).includes("/refresh") && (refreshes += 1) }
    );
    const r = await client.raw("https://chat.qwen.ai/api/v2/models/");
    assert.deepEqual(r.data, { ok: true });
    assert.equal(refreshes, 1);
  });

  test("retries do not leak across requests (the counter resets per call)", async () => {
    // Two separate calls, each hitting 401 once: both must recover.
    globalThis.fetch = fakeFetch([
      { actualStatus: "401", body: "" },
      { body: '{"success":true,"data":1}' },
      { actualStatus: "401", body: "" },
      { body: '{"success":true,"data":2}' },
    ]);
    assert.equal((await client.raw("https://chat.qwen.ai/api/v2/a")).data, 1);
    assert.equal((await client.raw("https://chat.qwen.ai/api/v2/b")).data, 2);
  });

  test("persistent 401 surfaces as an error instead of looping", async () => {
    globalThis.fetch = fakeFetch([{ actualStatus: "401", body: "" }]);
    await assert.rejects(() => client.raw("https://chat.qwen.ai/api/v2/models/"), /HTTP 401/);
  });

  test("absorbs refreshed cookies from Set-Cookie", async () => {
    globalThis.fetch = fakeFetch([{ body: "{}", setCookie: "sca=newvalue; Path=/" }]);
    await client.raw("https://auth.qwen.ai/api/v2/auths/refresh");
    assert.equal(client.session.cookies.sca, "newvalue");
  });

  test("stream mode rejects a non-SSE content type immediately", async () => {
    globalThis.fetch = fakeFetch([{ contentType: "application/json", body: "{}" }]);
    await assert.rejects(
      () =>
        (async () => {
          for await (const _ of client.stream({ group: "completions", path: "/chat/completions", method: "POST", body: {} })) {
            void _;
          }
        })(),
      (e) => e.code === "UnexpectedContentType"
    );
  });

  test("401 on a stream also refreshes and retries", async () => {
    let refreshes = 0;
    globalThis.fetch = fakeFetch(
      [
        { actualStatus: "401", body: "" },
        {
          contentType: "text/event-stream",
          body: "data: {\"content\":\"hi\"}\n\ndata: [DONE]\n\n",
        },
      ],
      { onCall: (u) => String(u).includes("/refresh") && (refreshes += 1) }
    );
    const evs = [];
    for await (const ev of client.stream({ group: "completions", path: "/chat/completions", method: "POST", body: {} })) {
      evs.push(ev);
    }
    assert.equal(evs.length, 1);
    assert.equal(refreshes, 1);
  });
});
