import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildPayload, foldStream, DEFAULTS } from "../src/chat.js";

describe("buildPayload", () => {
  test("requires a prompt", () => {
    assert.throws(() => buildPayload(), /prompt is required/);
    assert.throws(() => buildPayload({ prompt: "" }), /prompt is required/);
  });

  test("produces a well-formed envelope", () => {
    const p = buildPayload({ prompt: "hi" });
    assert.equal(p.action, "next");
    assert.equal(p.stream, true);
    assert.equal(p.chat_type, "t2t");
    assert.equal(p.model, DEFAULTS.model);
    assert.equal(p.messages.length, 1);
    assert.equal(p.messages[0].author.role, "user");
    assert.deepEqual(p.messages[0].content, { content_type: "text", parts: ["hi"] });
    assert.equal(typeof p.chat_id, "string");
    assert.notEqual(p.chat_id, p.id);
  });

  test("booleans are real booleans, not strings", () => {
    const p = buildPayload({ prompt: "x", useWebSearch: true, thinking: { enable_thinking: true } });
    assert.equal(p.use_web_search, true);
    assert.equal(p.thinking.enable_thinking, true);
    assert.equal(p.messages[0].thinking_enabled, true);
    assert.equal(p.messages[0].search_enabled, true);
    assert.equal(p.incremental_output, false);
    assert.equal(p.auto_search, false);
  });

  test("honours overrides", () => {
    const p = buildPayload({ prompt: "x", model: "m1", chatId: "c1", messageId: "m1id" });
    assert.equal(p.model, "m1");
    assert.equal(p.chat_id, "c1");
    assert.equal(p.id, "m1id");
    assert.equal(p.extra.model_name, "m1");
  });
});

describe("foldStream", () => {
  test("concatenates content deltas", () => {
    const f = foldStream([
      { json: { data: { content: "Hel" } } },
      { json: { data: { content: "lo" } } },
    ]);
    assert.equal(f.text, "Hello");
    assert.equal(f.reasoning, "");
    assert.equal(f.unknown.length, 0);
  });

  test("captures reasoning separately", () => {
    const f = foldStream([
      { json: { data: { reasoning_content: "think" } } },
      { json: { data: { content: "answer" } } },
    ]);
    assert.equal(f.reasoning, "think");
    assert.equal(f.text, "answer");
  });

  test("reads OpenAI-style choices deltas", () => {
    const f = foldStream([{ json: { choices: [{ delta: { content: "abc" } }] } }]);
    assert.equal(f.text, "abc");
  });

  test("extracts chat_id and keeps unknown events", () => {
    const f = foldStream([
      { json: { data: { chat_id: "c1" } } },
      { event: "ping", json: { data: {} } },
      { json: { weird: true } },
    ]);
    assert.equal(f.chatId, "c1");
    // chat_id-only + weird carry no text; the explicit ping is filtered.
    assert.equal(f.unknown.length, 2);
    assert.equal(f.events.length, 3);
  });

  test("tolerates empty input", () => {
    const f = foldStream();
    assert.equal(f.text, "");
    assert.equal(f.chatId, null);
  });
});
