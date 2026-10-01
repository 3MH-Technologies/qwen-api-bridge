import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { SSEParser, readSSE } from "../src/sse.js";

function fakeResponse(chunks, { abortAfter } = {}) {
  let i = 0;
  let cancelled = false;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const reader = {
    async read() {
      if (cancelled) return { done: true, value: undefined };
      // Simulate a stalled socket: never yields again unless cancelled.
      if (abortAfter !== undefined && i >= abortAfter) {
        while (!cancelled) await sleep(10);
        return { done: true, value: undefined };
      }
      if (i >= chunks.length) return { done: true, value: undefined };
      return { done: false, value: new TextEncoder().encode(chunks[i++]) };
    },
    cancel() {
      cancelled = true;
      return Promise.resolve();
    },
  };
  return { body: { getReader: () => reader }, wasCancelled: () => cancelled };
}

describe("SSEParser", () => {
  test("parses a simple event", () => {
    const p = new SSEParser();
    assert.deepEqual(p.push("data: hello\n\n"), [
      { event: "message", id: undefined, data: "hello", json: undefined },
    ]);
  });

  test("joins multi-line data and parses JSON", () => {
    const p = new SSEParser();
    const [ev] = p.push('data: {"a":\ndata: 1}\n\n');
    assert.equal(ev.data, '{"a":\n1}');
    assert.deepEqual(ev.json, { a: 1 });
  });

  test("ignores comments and honours named events", () => {
    const p = new SSEParser();
    const [ev] = p.push(": heartbeat\nevent: ping\ndata: x\n\n");
    assert.equal(ev.event, "ping");
    assert.equal(ev.data, "x");
  });

  test("handles events split across chunks", () => {
    const p = new SSEParser();
    assert.equal(p.push("data: par").length, 0);
    assert.equal(p.push("tial\n").length, 0);
    const [ev] = p.push("\n");
    assert.equal(ev.data, "partial");
  });

  test("handles CRLF line endings", () => {
    const p = new SSEParser();
    const [ev] = p.push("data: crlf\r\n\r\n");
    assert.equal(ev.data, "crlf");
  });

  test("end() flushes a trailing event without blank line", () => {
    const p = new SSEParser();
    p.push("data: tail");
    const [ev] = p.end();
    assert.equal(ev.data, "tail");
    assert.deepEqual(p.end(), []);
  });

  test("blocks with no data line are dropped", () => {
    const p = new SSEParser();
    assert.deepEqual(p.push("event: ping\n\n"), []);
  });
});

describe("readSSE", () => {
  async function collect(res, opts) {
    const out = [];
    for await (const ev of readSSE(res, opts)) out.push(ev);
    return out;
  }

  test("reads events until [DONE]", async () => {
    const res = fakeResponse(['data: one\n\ndata: two\n\n', "data: [DONE]\n\n"]);
    const evs = await collect(res);
    assert.deepEqual(evs.map((e) => e.data), ["one", "two"]);
    assert.ok(res.wasCancelled(), "socket must be released");
  });

  test("flushes a trailing event at EOF", async () => {
    const res = fakeResponse(["data: last\n\n"]);
    const evs = await collect(res);
    assert.deepEqual(evs.map((e) => e.data), ["last"]);
  });

  test("releases the reader when the consumer breaks early", async () => {
    const res = fakeResponse(["data: a\n\ndata: b\n\n", "data: c\n\n"]);
    for await (const ev of readSSE(res)) {
      if (ev.data === "a") break;
    }
    assert.ok(res.wasCancelled(), "early break must cancel the reader");
  });

  test("abort signal cancels the reader", async () => {
    const res = fakeResponse(["data: a\n\n"], { abortAfter: 1 });
    const ac = new AbortController();
    const pending = collect(res, { signal: ac.signal });
    setTimeout(() => ac.abort(), 20);
    const evs = await pending;
    assert.equal(evs.length, 1);
    assert.ok(res.wasCancelled(), "abort must release the socket");
  });
});
