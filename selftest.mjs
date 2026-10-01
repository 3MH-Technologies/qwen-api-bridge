const mods = await Promise.all(
  ["./src/routes.js", "./src/session.js", "./src/sse.js", "./src/client.js", "./src/chat.js", "./src/inpage.js", "./src/recorder.js", "./src/tools/build.js"]
    .map((m) => import(m))
);

const tools = mods[7].buildAllTools();
console.log("modules OK:", mods.length);
console.log("tools:", Object.keys(tools).length);

console.log("url:", tools["chats.getChat"].url({ chat_id: "abc-123" }));
console.log("url:", tools["tts.getTtsConfig"].url({ omni_speakers: "v1" }));

const payload = mods[4].buildPayload({ prompt: "hi" });
console.log("payload bytes:", JSON.stringify(payload).length);

console.log("fold:", JSON.stringify(mods[4].foldStream([
  { json: { data: { content: "Hel" } } },
  { json: { data: { content: "lo" } } },
  { json: { data: { chat_id: "c1" } } },
])));

const p = new mods[1].Session();
p.importCookieString("a=1; b=2");
p.absorb("c=3; Path=/; HttpOnly, d=; Max-Age=0");
console.log("session:", p.size, p.names(), "header:", p.header());

const rec = new mods[6].Recorder();
rec.ingest([
  { id: "1", url: "https://chat.qwen.ai/api/v2/models/", method: "GET", statusCode: 200, resourceType: "xhr" },
  { id: "2", url: "https://chat.qwen.ai/api/v2/chats/all", method: "GET", statusCode: 200, resourceType: "xhr" },
  { id: "3", url: "https://evil.example/x", method: "GET", statusCode: 200, resourceType: "xhr" },
]);
console.log("recorder kept:", rec.entries.length, "(filtered the non-Qwen host)");
console.log("summary:", rec.summary().map((s) => `${s.calls}x ${s.endpoint}`));
console.log("HAR entries:", rec.toHAR().log.entries.length);

// --- new: effective status, challenge detection, guarded routes -------------
const C = await import("./src/client.js");
const R = await import("./src/routes.js");

const fakeRes = (status, hdr) => ({ status, headers: { get: (k) => (k === "x-actual-status-code" ? hdr : null) } });
console.log("effective 200 + 401 header ->", C.effectiveStatus(fakeRes(200, "401")), "(expect 401)");
console.log("effective 200, no header   ->", C.effectiveStatus(fakeRes(200, null)), "(expect 200)");
console.log("effective 200 + garbage     ->", C.effectiveStatus(fakeRes(200, "abc")), "(expect 200)");

console.log("detect html body ->", C.detectChallenge("<html>_____tmd_____/punish?x5secdata=abc</html>"));
console.log("detect normal    ->", C.detectChallenge(JSON.stringify({ success: true, data: [] })));
console.log("detect empty     ->", C.detectChallenge(""));
console.log("stream timeout   ->", C.DEFAULT_STREAM_TIMEOUT_MS);

const e = new C.AntiBotError("https://chat.qwen.ai/api/v2/chat/completions", "x5secdata");
console.log("AntiBotError:", e.name, e.code, e.marker, "| instanceof QwenError:", e instanceof C.QwenError);

// guarded flags across all routes
const allTools = mods[7].buildAllTools();
const guardedNames = Object.values(allTools).filter((t) => t.guarded).map((t) => t.name);
console.log("guarded tools:", guardedNames.length, "of", Object.keys(allTools).length);
console.log("  completions.createCompletion ->", allTools["completions.createCompletion"].guarded, "(expect true)");
console.log("  auth.getSession              ->", allTools["auth.getSession"].guarded, "(expect true)");
console.log("  models.listModels            ->", allTools["models.listModels"].guarded, "(expect false)");
console.log("  configs.getConfig            ->", allTools["configs.getConfig"].guarded, "(expect false)");
console.log("  users.userStatus             ->", allTools["users.userStatus"].guarded, "(expect false)");
console.log("  tts.getTtsConfig             ->", allTools["tts.getTtsConfig"].guarded, "(expect false)");
console.log("  memory.memoryConfig          ->", allTools["memory.memoryConfig"].guarded, "(expect false)");
console.log("  member.memberLevel           ->", allTools["member.memberLevel"].guarded, "(expect false)");
console.log("  guarded list:", guardedNames.join(", "));