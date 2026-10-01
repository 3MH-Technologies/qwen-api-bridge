/**
 * Qwen API route registry.
 *
 * Every entry becomes one callable tool (see src/tools/build.js).
 *
 * `verified: true`  -> method + shape observed on the live site (network recording)
 * `verified: false` -> method inferred from REST semantics; run `npm run record`
 *                      to promote routes to verified once you exercise them.
 */

export const HOSTS = {
  chat: "https://chat.qwen.ai",
  auth: "https://auth.qwen.ai",
  coder: "https://coder.qwen.ai",
  qwen: "https://qwen.ai",
};

/** Groups control both the tool namespace and the CLI verb. */
export const GROUPS = {
  auth: { host: "auth", prefix: "/api/v2", desc: "Authentication, sessions, password, profile" },
  users: { host: "chat", prefix: "/api/v2", desc: "User status, settings, logout, audio tokens" },
  chats: { host: "chat", prefix: "/api/v2", desc: "Conversation CRUD, folders, archive, pin, share" },
  messages: { host: "chat", prefix: "/api/v2", desc: "Message level operations" },
  completions: { host: "chat", prefix: "/api/v2", desc: "Chat completion (SSE stream) and stop" },
  models: { host: "chat", prefix: "/api/v2", desc: "Model catalogue and per-model settings" },
  configs: { host: "chat", prefix: "/api/v2", desc: "Global config, tool toggles, feature flags" },
  files: { host: "chat", prefix: "/api/v2", desc: "Upload, parse, STS tokens, download links" },
  tasks: { host: "chat", prefix: "/api/v2", desc: "Background task status" },
  tts: { host: "chat", prefix: "/api/v2", desc: "Text to speech, voices, voice clone" },
  community: { host: "chat", prefix: "/api/v2", desc: "Community shares, likes, reports" },
  feedback: { host: "chat", prefix: "/api/v2", desc: "Evaluations and thumbs feedback" },
  member: { host: "chat", prefix: "/api/v2", desc: "Membership plans, orders, credits" },
  memory: { host: "chat", prefix: "/api/v2", desc: "Personalisation / memory profile" },
};

/**
 * Path prefixes the site's anti-bot SDK wraps with a challenge.
 *
 * Extracted verbatim from the `Kh` constant in
 * `qwen-chat-fe/0.3.12/js/main.js`, where Baxia installs
 * `checkApiPath: e => Kh.some(t => e.indexOf(t) > -1)`.
 *
 * Matching there is a substring test on the request path, so every entry
 * also covers its sub-routes: `/api/v2/chats` covers `/chats/all`,
 * `/chats/:chat_id`, and the message routes nested under it.
 *
 * This is routing metadata only. It records which paths the site treats as
 * sensitive; it does not affect, sign, or bypass anything.
 */
export const GUARDED_PREFIXES = Object.freeze([
  "/api/chat/completions",
  "/api/chats/new",
  "/api/chat/completed",
  "/api/v1/chats",
  "/api/v1/auths",
  "/api/task/suggestions/completions",
  "/api/v1/tasks/status",
  "/api/v1/files/getstsToken",
  "/api/task/title/completions",
  "/api/task/tags/completions",
  "/api/parse_url",
  "/api/v2/chats",
  "/api/v2/auths",
  "/api/v2/chat/completions",
  "/api/v2/task",
  "/api/v2/files/getstsToken",
  "/api/v2/community",
  "/api/v2/tts/completions",
  "/api/v2/files/getfilelink",
  "/api/v2/files/parse",
  "/api/v2/files/parse/status",
  "/api/v2/evaluations/feedback",
]);

/**
 * True when the site's own `checkApiPath` would match this route.
 * Same substring semantics as the bundle, applied to the full path.
 */
export function isGuarded(route) {
  const group = GROUPS[route.group];
  if (!group) return false;
  const full = group.prefix + route.path;
  return GUARDED_PREFIXES.some((p) => full.includes(p));
}

/**
 * path is relative to the group prefix, e.g. "/chats/all".
 * stream: response is text/event-stream.
 */
export const ROUTES = [
  // ---------------------------------------------------------------- auth
  { group: "auth", path: "/auths/refresh", method: "GET", verified: true, name: "refreshSession", desc: "Refresh the access token from the refresh cookie." },
  { group: "auth", path: "/auths/", method: "GET", verified: true, name: "getSession", desc: "Return the signed-in user profile, or a 401 payload when guest." },
  { group: "auth", path: "/auths/signup", method: "POST", verified: false, name: "signUp", desc: "Create an account with email + password.", body: { email: "string", password: "string", name: "string?" } },
  { group: "auth", path: "/auths/signin", method: "POST", verified: false, name: "signIn", desc: "Exchange credentials for a session.", body: { email: "string", password: "string" } },
  { group: "auth", path: "/auths/signout", method: "POST", verified: false, name: "signOut", desc: "Invalidate the current session." },
  { group: "auth", path: "/auths/otp/email/request", method: "POST", verified: false, name: "requestEmailOtp", desc: "Send a one-time code to an email address.", body: { email: "string" } },
  { group: "auth", path: "/auths/otp/email/verify", method: "POST", verified: false, name: "verifyEmailOtp", desc: "Verify a one-time code and open a session.", body: { email: "string", otp: "string" } },
  { group: "auth", path: "/auths/confirm/profile", method: "POST", verified: false, name: "confirmProfile", desc: "Complete the profile confirmation step after signup." },
  { group: "auth", path: "/auths/authorize/code", method: "GET", verified: false, name: "authorizeCode", desc: "Begin an OAuth style authorization code flow." },
  { group: "auth", path: "/auths/update/profile", method: "PATCH", verified: false, name: "updateProfile", desc: "Update display name or avatar." },
  { group: "auth", path: "/auths/update/password", method: "PATCH", verified: false, name: "updatePassword", desc: "Change the account password." },
  { group: "auth", path: "/auths/reset/password", method: "POST", verified: false, name: "resetPassword", desc: "Request or apply a password reset." },
  { group: "auth", path: "/auths/resendactivationemail", method: "POST", verified: false, name: "resendActivationEmail", desc: "Resend the account activation email." },

  // --------------------------------------------------------------- users
  { group: "users", path: "/users/status", method: "POST", verified: true, name: "userStatus", desc: "Probe whether the session is authenticated." },
  { group: "users", path: "/users/user/settings", method: "GET", verified: false, name: "getSettings", desc: "Read per-user preferences (theme, locale, defaults)." },
  { group: "users", path: "/users/user/settings/update", method: "POST", verified: false, name: "updateSettings", desc: "Write per-user preferences." },
  { group: "users", path: "/users/user/audio_chat_token", method: "GET", verified: false, name: "audioChatToken", desc: "Mint a short lived token for realtime voice chat." },
  { group: "users", path: "/users/logout/", method: "POST", verified: false, name: "logoutAll", desc: "Sign out every device." },

  // --------------------------------------------------------------- chats
  { group: "chats", path: "/chats/new", method: "POST", verified: false, name: "createChat", desc: "Create an empty conversation." },
  { group: "chats", path: "/chats/all", method: "GET", verified: false, name: "listChats", desc: "List conversations (paged).", query: { page: "number?", page_size: "number?" } },
  { group: "chats", path: "/chats/archived", method: "GET", verified: false, name: "listArchived", desc: "List archived conversations." },
  { group: "chats", path: "/chats/pinned", method: "GET", verified: false, name: "listPinned", desc: "List pinned conversations." },
  { group: "chats", path: "/chats/search", method: "GET", verified: false, name: "searchChats", desc: "Full text search over conversations.", query: { keyword: "string" } },
  { group: "chats", path: "/chats/:chat_id", method: "GET", verified: false, name: "getChat", desc: "Fetch one conversation with its messages.", params: { chat_id: "string" } },
  { group: "chats", path: "/chats/:chat_id", method: "PATCH", verified: false, name: "renameChat", desc: "Rename a conversation.", params: { chat_id: "string" }, body: { title: "string" } },
  { group: "chats", path: "/chats/:chat_id", method: "DELETE", verified: false, name: "deleteChat", desc: "Delete a conversation.", params: { chat_id: "string" } },
  { group: "chats", path: "/chats/:chat_id/clone", method: "POST", verified: false, name: "cloneChat", desc: "Duplicate a conversation." },
  { group: "chats", path: "/chats/:chat_id/pin", method: "POST", verified: false, name: "pinChat", desc: "Toggle the pinned flag." },
  { group: "chats", path: "/chats/:chat_id/share", method: "POST", verified: false, name: "shareChat", desc: "Create a public share link." },
  { group: "chats", path: "/chats/:chat_id/folder", method: "POST", verified: false, name: "moveToFolder", desc: "Move a conversation into a folder." },
  { group: "chats", path: "/chats/:chat_id/check", method: "GET", verified: false, name: "checkChat", desc: "Validate that a chat id is usable." },
  { group: "chats", path: "/chats/batch_delete", method: "POST", verified: false, name: "batchDeleteChats", desc: "Delete many conversations at once." },
  { group: "chats", path: "/chats/archive/all", method: "POST", verified: false, name: "archiveAll", desc: "Archive every conversation." },
  { group: "chats", path: "/chats/import", method: "POST", verified: false, name: "importChats", desc: "Import an exported conversation archive." },
  { group: "chats", path: "/chats/folder/:folder_id", method: "DELETE", verified: false, name: "deleteFolder", desc: "Delete a conversation folder." },

  // ------------------------------------------------------------ messages
  { group: "messages", path: "/chats/:chat_id/messages/:message_id", method: "PATCH", verified: false, name: "editMessage", desc: "Edit a sent message and regenerate.", params: { chat_id: "string", message_id: "string" } },
  { group: "messages", path: "/chats/:chat_id/messages/:message_id", method: "DELETE", verified: false, name: "deleteMessage", desc: "Delete one message." },
  { group: "messages", path: "/chats/:chat_id/messages/:message_id/save_as_copy", method: "POST", verified: false, name: "forkMessage", desc: "Branch a new conversation from a message." },
  { group: "messages", path: "/chats/:chat_id/messages/batch_delete", method: "POST", verified: false, name: "batchDeleteMessages", desc: "Delete many messages at once." },
  { group: "messages", path: "/chats/:chat_id/messages/select", method: "POST", verified: false, name: "selectMessages", desc: "Select a message range for export or reuse." },

  // ---------------------------------------------------------- completions
  { group: "completions", path: "/chat/completions", method: "POST", verified: true, stream: true, name: "createCompletion", desc: "Send a message and stream the model reply over SSE.", note: "Method and path observed. A guest, script-initiated request is answered by the Alibaba anti-bot challenge (_____tmd_____/punishTextFetch, x5secdata) which never completes the SSE stream. Use a signed-in browser session.", body: { chat_id: "string?", id: "string?", message: "object", model: "string?", mode: "string?", stream: "boolean?", incremental_output: "boolean?", action: "string?" } },
  { group: "completions", path: "/chat/completions/stop", method: "POST", verified: false, name: "stopCompletion", desc: "Abort an in-flight generation." },
  { group: "completions", path: "/chat/:chat_id/:message_id", method: "GET", verified: false, name: "streamResume", desc: "Resume or replay a streamed message by id." },
  { group: "completions", path: "/chat/arena/in-progress", method: "GET", verified: false, name: "arenaInProgress", desc: "List arena battles currently in progress." },
  { group: "completions", path: "/chat/report/omni", method: "POST", verified: false, name: "reportOmni", desc: "Report a multimodal generation result." },

  // --------------------------------------------------------------- models
  { group: "models", path: "/models/", method: "GET", verified: true, name: "listModels", desc: "Full model catalogue with capabilities, limits and chat types." },
  { group: "models", path: "/models/:model_id", method: "GET", verified: false, name: "getModel", desc: "Detail for a single model." },

  // -------------------------------------------------------------- configs
  { group: "configs", path: "/configs/", method: "GET", verified: true, name: "getConfig", desc: "Feature flags, available tools and site wide options." },
  { group: "configs", path: "/configs/setting-config", method: "GET", verified: true, name: "getSettingConfig", desc: "Remote settings: enabled features, banners, experiment flags." },

  // ---------------------------------------------------------------- files
  { group: "files", path: "/files/getstsToken", method: "POST", verified: false, name: "getStsToken", desc: "Get an OSS STS token for direct uploads." },
  { group: "files", path: "/files/parse", method: "POST", verified: false, name: "parseFile", desc: "Parse an uploaded document into chat context." },
  { group: "files", path: "/files/parse/status", method: "GET", verified: false, name: "parseStatus", desc: "Poll a document parse job." },
  { group: "files", path: "/files/getfilelink", method: "POST", verified: false, name: "getFileLink", desc: "Mint a temporary download link for a stored file." },
  { group: "files", path: "/files/customer-service/entry", method: "GET", verified: false, name: "customerServiceEntry", desc: "Support entry point configuration." },

  // ---------------------------------------------------------------- tasks
  { group: "tasks", path: "/task", method: "POST", verified: false, name: "createTask", desc: "Create a background task." },
  { group: "tasks", path: "/tasks/status", method: "GET", verified: false, name: "taskStatus", desc: "Poll background task status." },

  // ------------------------------------------------------------------ tts
  { group: "tts", path: "/tts/config", method: "GET", verified: true, name: "getTtsConfig", desc: "Available voices, speakers and languages.", query: { omni_speakers: "string?", audio_tts_speakers: "string?", omni_language: "string?", audio_tts_language: "string?" } },
  { group: "tts", path: "/tts/completions", method: "POST", verified: false, name: "ttsCompletion", desc: "Synthesise speech." },
  { group: "tts", path: "/tts/voice/list/detail", method: "GET", verified: false, name: "listVoices", desc: "List cloned voices." },
  { group: "tts", path: "/tts/voice/clone", method: "POST", verified: false, name: "cloneVoice", desc: "Create a cloned voice." },
  { group: "tts", path: "/tts/voice/rename", method: "POST", verified: false, name: "renameVoice", desc: "Rename a cloned voice." },
  { group: "tts", path: "/tts/voice/delete/:voice_id", method: "DELETE", verified: false, name: "deleteVoice", desc: "Delete a cloned voice." },
  { group: "tts", path: "/tts/voice/synthesis_text", method: "GET", verified: false, name: "synthesisText", desc: "Fetch synthesis text for a voice." },
  { group: "tts", path: "/tts/design/prompt", method: "GET", verified: false, name: "ttsDesignPrompt", desc: "Prompt templates for voice design." },
  { group: "tts", path: "/tts/design/save", method: "POST", verified: false, name: "saveTtsDesign", desc: "Save a voice design." },
  { group: "tts", path: "/tts/design/voice", method: "GET", verified: false, name: "ttsDesignVoice", desc: "Voice options for voice design." },

  // ----------------------------------------------------------- community
  { group: "community", path: "/community/contents", method: "GET", verified: false, name: "communityContents", desc: "Browse community feed content." },
  { group: "community", path: "/community/collections", method: "GET", verified: false, name: "communityCollections", desc: "Browse community collections." },
  { group: "community", path: "/community/host_graph", method: "GET", verified: false, name: "hostGraph", desc: "Community graph feed." },
  { group: "community", path: "/community/mobile/chatcontrols", method: "GET", verified: false, name: "chatControls", desc: "Mobile chat control options." },
  { group: "community", path: "/community/share", method: "GET", verified: false, name: "communityShares", desc: "List shared conversations." },
  { group: "community", path: "/community/share/:share_id", method: "GET", verified: false, name: "getCommunityShare", desc: "Fetch a shared conversation." },
  { group: "community", path: "/community/share/:share_id/like", method: "POST", verified: false, name: "likeShare", desc: "Like a shared conversation." },
  { group: "community", path: "/community/share/:share_id/unlike", method: "POST", verified: false, name: "unlikeShare", desc: "Remove a like." },
  { group: "community", path: "/community/share/:share_id/report", method: "POST", verified: false, name: "reportShare", desc: "Report a shared conversation." },

  // ------------------------------------------------------------- feedback
  { group: "feedback", path: "/evaluations/feedback", method: "POST", verified: false, name: "sendFeedback", desc: "Submit thumbs up/down feedback for a message." },

  // --------------------------------------------------------------- member
  { group: "member", path: "/member/level/query", method: "GET", verified: false, name: "memberLevel", desc: "Current membership level and entitlements." },
  { group: "member", path: "/member/product/query", method: "GET", verified: false, name: "memberProducts", desc: "List subscription plans." },
  { group: "member", path: "/member/order/precreate", method: "POST", verified: false, name: "precreateOrder", desc: "Create a subscription order." },
  { group: "member", path: "/member/order/status", method: "GET", verified: false, name: "orderStatus", desc: "Poll a subscription order." },
  { group: "member", path: "/member/product/subscribe/cancel", method: "POST", verified: false, name: "cancelSubscription", desc: "Cancel a subscription." },
  { group: "member", path: "/entitlement/credits/credits/history", method: "GET", verified: false, name: "creditHistory", desc: "Generation credit history." },

  // --------------------------------------------------------------- memory
  { group: "memory", path: "/memory/config", method: "GET", verified: false, name: "memoryConfig", desc: "Personalisation configuration." },
  { group: "memory", path: "/memory/detail", method: "GET", verified: false, name: "memoryDetail", desc: "Stored memory entries." },
];

/** Turn `/chats/:chat_id` into a real URL given values. */
export function resolvePath(template, params = {}) {
  return template.replace(/:([a-z_]+)/g, (_, key) => {
    if (params[key] === undefined) {
      throw new Error(`Missing path parameter "${key}" for ${template}`);
    }
    return encodeURIComponent(String(params[key]));
  });
}

/** Full URL for a route. */
export function routeUrl(route, { params = {}, query = {} } = {}) {
  const group = GROUPS[route.group];
  if (!group) throw new Error(`Unknown group "${route.group}"`);
  const host = HOSTS[group.host];
  const path = resolvePath(group.prefix + route.path, params);
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
  }
  const suffix = qs.toString() ? `?${qs}` : "";
  return `${host}${path}${suffix}`;
}

/** Tool name, namespaced by group: e.g. `chats.listChats`. */
export function toolName(route) {
  return `${route.group}.${route.name}`;
}