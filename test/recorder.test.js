import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Recorder } from "../src/recorder.js";

const API = "https://chat.qwen.ai/api/v2";

describe("Recorder", () => {
  test("filters non-Qwen hosts", () => {
    const r = new Recorder();
    r.ingest([
      { id: "1", url: `${API}/models/`, method: "GET", statusCode: 200 },
      { id: "2", url: "https://evil.example/x", method: "GET", statusCode: 200 },
      { id: "3", url: "https://chat.qwen.ai/static/app.js", method: "GET", statusCode: 200 },
    ]);
    assert.equal(r.entries.length, 1);
    assert.ok(Recorder.isApiUrl(`${API}/chats/all`));
    assert.ok(!Recorder.isApiUrl("https://chat.qwen.ai/static/x.js"));
  });

  test("summary groups by endpoint, most-called first", () => {
    const r = new Recorder();
    r.ingest([
      { id: "1", url: `${API}/models/`, method: "GET", statusCode: 200 },
      { id: "2", url: `${API}/chats/all?page=1`, method: "GET", statusCode: 200 },
      { id: "3", url: `${API}/chats/all?page=2`, method: "GET", statusCode: 500 },
      { id: "4", url: `${API}/chats/all?page=3`, method: "GET", statusCode: 200 },
    ]);
    const s = r.summary();
    assert.equal(s[0].endpoint, `GET ${API}/chats/all`);
    assert.equal(s[0].calls, 3);
    assert.deepEqual(s[0].statuses.sort(), [200, 500]);
    assert.equal(s.length, 2);
  });

  test("summary reports bodies when present", () => {
    const r = new Recorder();
    r.ingest([{ id: "1", url: `${API}/models/`, method: "GET", statusCode: 200 }], {
      1: { requestBody: '{"a":1}', responseBody: '{"b":2}' },
    });
    const [row] = r.summary();
    assert.equal(row.hasRequestBody, true);
    assert.equal(row.hasResponseBody, true);
  });

  test("normalises id-like path segments", () => {
    const r = new Recorder();
    r.ingest([
      { id: "1", url: `${API}/chats/12345678-1234-1234-1234-123456789012`, method: "GET" },
      { id: "2", url: `${API}/chats/87654321-4321-4321-4321-210987654321`, method: "GET" },
    ]);
    assert.equal(r.summary().length, 1, "UUIDs collapse into one endpoint");
  });

  test("produces a valid HAR 1.2 document", () => {
    const r = new Recorder({ name: "unit" });
    r.ingest([{ id: "1", url: `${API}/models/`, method: "GET", statusCode: 200, timestampMs: Date.now() }], {
      1: { responseBody: '{"ok":true}' },
    });
    const har = r.toHAR();
    assert.equal(har.log.version, "1.2");
    assert.equal(har.log.creator.name, "unit");
    assert.equal(har.log.entries.length, 1);
    const e = har.log.entries[0];
    assert.equal(e.request.method, "GET");
    assert.equal(e.response.status, 200);
    assert.equal(e.response.content.text, '{"ok":true}');
    assert.ok(!Number.isNaN(Date.parse(e.startedDateTime)));
  });
});
