/**
 * Chat helper: compose the /api/v2/chat/completions payload and fold the SSE
 * stream back into plain text.
 *
 * The envelope is inferred from the observed web client. If a field is
 * rejected, `npm run record` a real turn and diff against `payloadShape`.
 */
import { randomUUID } from "node:crypto";

export const DEFAULTS = {
  model: "qwen3.7-plus",
  mode: "simple",
  incremental_output: false,
  thinking: { enable_thinking: false },
  auto_search: false,
};

/** Build a fresh completion payload. */
export function buildPayload({
  prompt,
  model = DEFAULTS.model,
  chatId = randomUUID(),
  messageId = randomUUID(),
  files = [],
  mode = DEFAULTS.mode,
  incrementalOutput = DEFAULTS.incremental_output,
  thinking = DEFAULTS.thinking,
  autoSearch = DEFAULTS.auto_search,
  useWebSearch = false,
} = {}) {
  if (!prompt) throw new Error("prompt is required");

  return {
    chat_id: chatId,
    id: messageId,
    action: "next",
    model,
    mode,
    stream: true,
    incremental_output: incrementalOutput,
    chat_type: "t2t",
    thinking,
    auto_search: autoSearch,
    use_web_search: useWebSearch,
    files,
    messages: [
      {
        id: messageId,
        author: { role: "user", name: "user", metadata: userMeta() },
        content: { content_type: "text", parts: [String(prompt)] },
        status: "finished",
        metadata: { is_division: false },
        create_time: Date.now(),
        chat_type: "t2t",
        model,
        finish_reason: null,
        apos_identifier: null,
        thinking_enabled: Boolean(thinking?.enable_thinking),
        search_enabled: Boolean(useWebSearch),
      },
    ],
    incremental_input: 0,
    extra: {
      language: null,
      model_name: model,
      mode,
      deep_thinking: Boolean(thinking?.enable_thinking),
      use_search: useWebSearch,
    },
  };
}

function userMeta() {
  return { user_id: "", avatar: "", user_name: "", is_login: false };
}

/**
 * Fold SSE events into { text, reasoning, events }.
 * Tolerant on purpose: different builds emit different shapes, so unknown
 * event shapes are preserved in `events` rather than dropped.
 */
export function foldStream(events = []) {
  let text = "";
  let reasoning = "";
  let chatId = null;
  const unknown = [];

  for (const ev of events) {
    const d = ev.json ?? {};
    const data = d.data ?? d;
    if (data.chat_id && !chatId) chatId = data.chat_id;

    const delta = extractText(data);
    if (delta.content) text += delta.content;
    if (delta.reasoning) reasoning += delta.reasoning;
    if (!delta.content && !delta.reasoning) {
      if (ev.event !== "ping" && data !== null) unknown.push(ev);
    }
  }
  return { chatId, text, reasoning, events, unknown };
}

function extractText(data) {
  const out = { content: "", reasoning: "" };
  const chunks = data?.choices?.[0]?.delta ?? data?.choices?.[0]?.message ?? null;
  const raw = chunks?.content;
  if (typeof raw === "string") out.content += raw;
  else if (Array.isArray(raw)) {
    for (const p of raw) {
      if (typeof p === "string") out.content += p;
      else if (p?.text) out.content += p.text;
    }
  }
  if (typeof data?.content === "string") out.content += data.content;
  if (typeof data?.reasoning_content === "string") out.reasoning += data.reasoning_content;
  else if (typeof data?.thinking === "string") out.reasoning += data.thinking;
  return out;
}