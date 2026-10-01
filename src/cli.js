#!/usr/bin/env node
/**
 * qwen CLI — drive the chat.qwen.ai internal API from the terminal.
 *
 *   qwen auth-import "<cookie string>"   load session cookies from the browser
 *   qwen auth-status                    check whether the session is signed in
 *   qwen tools                          list every generated tool
 *   qwen tools-json                     dump the manifest as JSON
 *   qwen models                         model catalogue (all site options)
 *   qwen configs                        feature flags + available tools
 *   qwen settings                       remote setting-config
 *   qwen tts                            voices and languages
 *   qwen chat "<prompt>"                send a message, print the reply
 *   qwen chats                          list conversations
 *   qwen call <tool> [json]             invoke any tool by name
 *   qwen record [file.har]              summarise a recording
 */
import { readFileSync, existsSync } from "node:fs";
import { QwenClient } from "./client.js";
import { Session } from "./session.js";
import { buildAllTools, toolsManifest } from "./tools/build.js";
import { ROUTES } from "./routes.js";
import { Recorder } from "./recorder.js";
import { buildPayload, foldStream } from "./chat.js";

const [, , cmd, ...rest] = process.argv;
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const tools = buildAllTools();

function out(obj) {
  console.log(typeof obj === "string" ? obj : JSON.stringify(obj, null, 2));
}

function client() {
  const c = QwenClient.fromDisk();
  c.onRetry = (url) => console.error(`  401 -> refreshing session for ${new URL(url).pathname}`);
  return c;
}

async function callTool(name, args, opts = {}) {
  const tool = tools[name];
  if (!tool) {
    console.error(`Unknown tool "${name}". Try: qwen tools`);
    process.exit(1);
  }
  return tool.invoke(client(), args, opts);
}

const commands = {
  async "auth-import"(value) {
    const s = Session.load();
    const raw = value && existsSync(value) ? readFileSync(value, "utf8") : value;
    if (!raw) {
      console.error('Usage: qwen auth-import "<cookie string>" | <session.json>');
      process.exit(1);
    }
    let handled = false;
    if (raw.trim().startsWith("{")) {
      try {
        const json = JSON.parse(raw);
        if (json.cookies || json.cookieString || json.token) {
          if (json.cookies) Object.assign(s.cookies, json.cookies);
          else s.importSessionJson(json);
          handled = true;
        }
      } catch {
        /* not a session export: fall through and treat it as a cookie string */
      }
    }
    if (!handled) s.importCookieString(raw);
    const file = s.save();
    out(
      `Imported ${s.size} cookies${s.accessToken ? " + access token" : ""} -> ${file}\n  names: ${s.names().join(", ")}`
    );
  },

  async "auth-status"() {
    const c = client();
    const ok = await c.isAuthenticated();
    out({ authenticated: ok, access_token: Boolean(c.session.accessToken), cookies: c.session.names() });
  },

  async tools() {
    const rows = Object.values(tools).map((t) => ({
      tool: t.name,
      method: t.method,
      path: t.path,
      stream: t.stream ? "yes" : "",
      verified: t.verified ? "yes" : "-",
      desc: t.description,
    }));
    console.table(rows);
    const groups = new Set(Object.values(tools).map((t) => t.group));
    const verified = rows.filter((r) => r.verified === "yes").length;
    console.log(`\n${rows.length} tools across ${groups.size} groups (${verified} verified against the live site).`);
  },

  async "tools-json"() {
    out(toolsManifest());
  },

  async models() {
    const data = await callTool("models.listModels");
    const list = data?.data ?? data?.models ?? data ?? [];
    const rows = (Array.isArray(list) ? list : []).map((m) => ({
      id: m.id,
      name: m.name ?? m.info?.name,
      context: m.info?.meta?.max_context_length,
      vision: m.info?.meta?.capabilities?.vision ? "y" : "",
      doc: m.info?.meta?.capabilities?.document ? "y" : "",
      video: m.info?.meta?.capabilities?.video ? "y" : "",
      audio: m.info?.meta?.capabilities?.audio ? "y" : "",
      thinking: m.info?.meta?.capabilities?.thinking ? "y" : "",
      search: m.info?.meta?.capabilities?.search ? "y" : "",
      chat_types: (m.info?.meta?.chat_type ?? []).join(","),
    }));
    console.table(rows);
  },

  async configs() {
    out(await callTool("configs.getConfig"));
  },

  async settings() {
    out(await callTool("configs.getSettingConfig"));
  },

  async tts() {
    out(await callTool("tts.getTtsConfig", {
      omni_speakers: "v1",
      audio_tts_speakers: "v1",
      omni_language: "v1",
      audio_tts_language: "v1",
    }));
  },

  async chats() {
    out(await callTool("chats.listChats", { page: 1, page_size: 20 }));
  },

  async chat(prompt, ...flags) {
    const opts = { prompt };
    for (const f of flags) {
      const [k, v] = f.replace(/^--/, "").split("=");
      opts[k.replace(/-/g, "_")] = v ?? true;
    }
    const payload = buildPayload({
      prompt,
      model: opts.model || "qwen3.7-plus",
      useWebSearch: opts.search === true || opts.search === "true",
      thinking: { enable_thinking: opts.thinking === true || opts.thinking === "true" },
    });

    const route = ROUTES.find((r) => r.name === "createCompletion");
    const c = client();
    const events = [];
    process.stderr.write("streaming");
    try {
      for await (const ev of c.stream(route, { ...payload })) {
        events.push(ev);
        process.stderr.write(".");
      }
    } catch (e) {
      console.error(`\n  error: ${e.message}`);
      if (e.code) console.error(`  code: ${e.code}`);
      process.exit(1);
    }
    process.stderr.write("\n");
    const folded = foldStream(events);
    out(folded.text || folded.reasoning || { note: "no text extracted", raw: events.slice(0, 5) });
  },

  async call(toolName, jsonArgs) {
    const args = jsonArgs ? JSON.parse(jsonArgs) : {};
    out(await callTool(toolName, args));
  },

  async record(file) {
    const path = file ?? rest.find((f) => f.endsWith(".har"));
    if (!path || !existsSync(path)) {
      console.error("Usage: qwen record <capture.har>");
      process.exit(1);
    }
    const har = JSON.parse(readFileSync(path, "utf8"));
    const rec = new Recorder();
    rec.ingest(
      har.log.entries.map((e, i) => ({
        id: String(i),
        url: e.request.url,
        method: e.request.method,
        resourceType: e._resourceType ?? "xhr",
        statusCode: e.response.status,
        timestampMs: Date.parse(e.startedDateTime),
        durationMs: e.time,
      })),
      Object.fromEntries(
        har.log.entries.map((e, i) => [
          String(i),
          {
            requestHeaders: e.request.headers,
            responseHeaders: e.response.headers,
            requestBody: e.request.postData?.text ?? null,
            responseBody: e.response.content?.text ?? null,
          },
        ])
      )
    );
    console.table(rec.summary());
    out(`\n${rec.entries.length} API calls recorded in ${path}`);
  },

  async routes() {
    out(ROUTES.map((r) => `${r.verified ? "[verified]" : "[inferred]"} ${r.method.padEnd(6)} ${r.path}`).join("\n"));
  },
};

const fn = commands[cmd];

// `qwen --help` / `qwen help` / `qwen --version` / `qwen -v`
if (cmd === "--help" || cmd === "-h" || cmd === "help") {
  console.log(usage());
  process.exit(0);
}
if (cmd === "--version" || cmd === "-v") {
  console.log(pkg.version);
  process.exit(0);
}

if (!fn) {
  console.error(cmd ? `Unknown command "${cmd}".\n` : "");
  console.log(usage());
  process.exit(cmd ? 1 : 0);
}

try {
  await fn(...rest);
} catch (e) {
  console.error(`\nError: ${e.message}`);
  if (e.code) console.error(`code: ${e.code}`);
  if (e.details) console.error(`details: ${e.details}`);
  if (process.env.QWEN_DEBUG) console.error(e.stack);
  process.exit(1);
}

function usage() {
  return `${pkg.name} ${pkg.version}

Usage: qwen <command> [args]

Session
  auth-import <cookie|file>   load session cookies from the browser
  auth-status                 am I signed in?

Catalogue
  models                      model catalogue
  configs                     feature flags + available tools
  settings                    remote settings
  tts                         voices and languages
  chats                       conversation list

Chat
  chat "<prompt>" [--model=x] [--thinking] [--search]
                              send a message and print the reply

Tools
  tools                       list every tool
  tools-json                  tool manifest as JSON
  call <tool> [json]          invoke any tool by name
  routes                      route table with verification state

Capture
  record <file.har>           summarise a recording

General
  -h, --help                  show this help
  -v, --version               print the version

Set QWEN_DEBUG=1 to print full stack traces on errors.`;
}