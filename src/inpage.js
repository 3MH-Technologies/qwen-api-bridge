/**
 * In-page transport.
 *
 * Some environments (sandboxes, CI, corporate networks) block direct Node
 * egress while the browser can reach the API fine. This module is injected
 * into the chat.qwen.ai page and talks to the API from there, reusing the
 * page's own cookies, origin and WAF clearance.
 *
 * `PAGE_SOURCE` is the string to hand to `browser.evaluate`. `PAGE_EXPORTS`
 * is the callable surface it installs on window.
 */

/** A tool surface that runs inside the page. Kept dependency free. */
export const PAGE_SOURCE = String.raw`
(() => {
  const ORIGIN = "https://chat.qwen.ai";
  const AUTH = "https://auth.qwen.ai";
  const rid = () => (crypto.randomUUID ? crypto.randomUUID() :
    "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === "x" ? r : (r & 0x3 | 0x8)).toString(16);
    }));

  function headers(extra) {
    return Object.assign({
      accept: "application/json, text/plain, */*",
      "x-request-id": rid(),
    }, extra || {});
  }

  function unwrap(payload, url) {
    if (payload && typeof payload === "object" && payload.success === false) {
      const inner = payload.data || {};
      const err = new Error(inner.code || "RequestFailed");
      err.code = inner.code;
      err.details = inner.details;
      err.url = url;
      throw err;
    }
    return payload && typeof payload === "object" && "data" in payload ? payload.data : payload;
  }

  async function api(path, opts) {
    opts = opts || {};
    const url = path.startsWith("http") ? path
      : (opts.host === "auth" ? AUTH : ORIGIN) + path;
    const init = {
      method: opts.method || "GET",
      credentials: "include",
      headers: headers(
        opts.body !== undefined
          ? Object.assign({ "content-type": "application/json" }, opts.headers)
          : opts.headers
      ),
    };
    if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
    if (opts.signal) init.signal = opts.signal;

    const res = await fetch(url, init);
    if (opts.raw) return res;
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    if (!res.ok && !(json && json.success === false)) {
      const err = new Error("HTTP " + res.status); err.status = res.status; throw err;
    }
    return unwrap(json, url);
  }

  function fold(events) {
    let text = "", reasoning = "", chatId = null;
    for (const ev of events) {
      const d = ev.json || {};
      const data = d.data || d;
      if (data.chat_id && !chatId) chatId = data.chat_id;
      const delta = data.choices && data.choices[0] && (data.choices[0].delta || data.choices[0].message);
      const raw = delta && delta.content;
      if (typeof raw === "string") text += raw;
      else if (Array.isArray(raw)) {
        for (const p of raw) text += typeof p === "string" ? p : (p && p.text) || "";
      }
      if (typeof data.content === "string") text += data.content;
      if (typeof data.reasoning_content === "string") reasoning += data.reasoning_content;
      else if (typeof data.thinking === "string") reasoning += data.thinking;
    }
    return { chatId, text, reasoning, eventCount: events.length };
  }

  async function* sse(res) {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.search(/\r?\n\r?\n/)) !== -1) {
        const m = buf.slice(i).match(/^\r?\n\r?\n/);
        const raw = buf.slice(0, i);
        buf = buf.slice(i + m[0].length);
        const lines = [];
        for (const line of raw.split(/\r?\n/)) {
          if (!line || line[0] === ":") continue;
          const c = line.indexOf(":");
          lines.push(c === -1 ? line : line.slice(c + 1).replace(/^ /, ""));
        }
        if (!lines.length) continue;
        const payload = lines.join("\n");
        if (payload === "[DONE]") return;
        let json; try { json = JSON.parse(payload); } catch {}
        yield { data: payload, json };
      }
    }
  }

  return {
    api,
    // --- session -------------------------------------------------------
    userStatus: () => api("/api/v2/users/status", { method: "POST" }),
    session: () => api("/api/v2/auths/", { host: "auth" }),
    // --- site options --------------------------------------------------
    models: () => api("/api/v2/models/"),
    config: () => api("/api/v2/configs/"),
    settingConfig: () => api("/api/v2/configs/setting-config"),
    ttsConfig: () => api("/api/v2/tts/config?omni_speakers=v1&audio_tts_speakers=v1&omni_language=v1&audio_tts_language=v1"),
    // --- conversations -------------------------------------------------
    listChats: (p, n) => api("/api/v2/chats/all?page=" + (p || 1) + "&page_size=" + (n || 20)),
    getChat: (id) => api("/api/v2/chats/" + encodeURIComponent(id)),
    // --- chat ----------------------------------------------------------
    async chat(prompt, opts) {
      opts = opts || {};
      const model = opts.model || "qwen3.7-plus";
      const chatId = opts.chatId || rid();
      const msgId = rid();
      const payload = {
        chat_id: chatId,
        id: msgId,
        action: "next",
        model,
        mode: opts.mode || "simple",
        stream: true,
        incremental_output: false,
        chat_type: "t2t",
        thinking: { enable_thinking: Boolean(opts.thinking) },
        auto_search: false,
        use_web_search: Boolean(opts.search),
        files: [],
        messages: [{
          id: msgId,
          author: { role: "user", name: "user", metadata: { user_id: "", avatar: "", user_name: "", is_login: false } },
          content: { content_type: "text", parts: [String(prompt)] },
          status: "finished",
          metadata: { is_division: false },
          create_time: Date.now(),
          chat_type: "t2t",
          model,
          thinking_enabled: Boolean(opts.thinking),
          search_enabled: Boolean(opts.search),
        }],
        incremental_input: 0,
        extra: { language: null, model_name: model, mode: opts.mode || "simple",
                 deep_thinking: Boolean(opts.thinking), use_search: Boolean(opts.search) },
      };
      const res = await api("/api/v2/chat/completions", { method: "POST", body: payload, raw: true, signal: opts.signal });
      const events = [];
      for await (const ev of sse(res)) events.push(ev);
      return Object.assign(fold(events), { chatId, model });
    },
  };
})()
`;

export function pageBootstrap(extraArgs = []) {
  return `(() => {
  const Q = ${PAGE_SOURCE};
  ${extraArgs.length ? `return Promise.all([${extraArgs.map((a) => `Q.${a}`).join(", ")}]);` : "return Object.keys(Q);"}
})()`;
}