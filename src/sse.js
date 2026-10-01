/**
 * Minimal Server-Sent Events reader for the completion stream.
 *
 * Handles: `data:` lines, multi-line data, comments (`:` heartbeats),
 * and the `[DONE]` sentinel.
 */
export class SSEParser {
  constructor() {
    this.buffer = "";
    this.onEvent = () => {};
  }

  /** Feed a chunk of text; returns the parsed events. */
  push(chunk) {
    this.buffer += chunk;
    const events = [];
    let idx;
    // Events are separated by a blank line (\n\n or \r\n\r\n).
    while ((idx = this.buffer.search(/\r?\n\r?\n/)) !== -1) {
      const match = this.buffer.slice(idx).match(/^\r?\n\r?\n/);
      const raw = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + match[0].length);
      const parsed = parseBlock(raw);
      if (parsed) {
        events.push(parsed);
        this.onEvent(parsed);
      }
    }
    return events;
  }

  /** Flush a trailing event that arrived without a final blank line. */
  end() {
    const events = [];
    if (this.buffer.trim()) {
      const parsed = parseBlock(this.buffer);
      if (parsed) events.push(parsed);
      this.buffer = "";
    }
    return events;
  }
}

function parseBlock(raw) {
  const dataLines = [];
  let eventName = "message";
  let id;
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) continue; // comment / heartbeat
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") dataLines.push(value);
    else if (field === "event") eventName = value;
    else if (field === "id") id = value;
  }
  if (!dataLines.length) return null;
  const data = dataLines.join("\n");
  let json;
  try {
    json = JSON.parse(data);
  } catch {
    json = undefined;
  }
  return { event: eventName, id, data, json };
}

/** Read a fetch Response body stream into SSE events. */
export async function* readSSE(response, { signal } = {}) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parser = new SSEParser();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const ev of parser.push(decoder.decode(value, { stream: true }))) {
        if (ev.data === "[DONE]") return;
        yield ev;
      }
    }
    for (const ev of parser.end()) {
      if (ev.data === "[DONE]") return;
      yield ev;
    }
  } finally {
    if (signal?.aborted) reader.cancel().catch(() => {});
  }
}