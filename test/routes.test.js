import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { ROUTES, GROUPS, HOSTS, resolvePath, routeUrl, toolName, isGuarded, GUARDED_PREFIXES } from "../src/routes.js";
import { buildAllTools, buildTool, toolsManifest } from "../src/tools/build.js";

describe("route registry", () => {
  test("every route belongs to a known group", () => {
    for (const r of ROUTES) assert.ok(GROUPS[r.group], `unknown group "${r.group}" on ${r.name}`);
  });

  test("route names are unique within their group", () => {
    const seen = new Set();
    for (const r of ROUTES) {
      const n = toolName(r);
      assert.ok(!seen.has(n), `duplicate tool name ${n}`);
      seen.add(n);
    }
  });

  test("methods are valid HTTP verbs", () => {
    const VERBS = new Set(["GET", "POST", "PATCH", "PUT", "DELETE"]);
    for (const r of ROUTES) assert.ok(VERBS.has(r.method), `${r.name}: ${r.method}`);
  });

  test("routes with path params declare them", () => {
    for (const r of ROUTES) {
      const placeholders = [...r.path.matchAll(/:([a-z_]+)/g)].map((m) => m[1]);
      for (const p of placeholders) {
        assert.ok(r.params && p in r.params, `${r.name} missing params.${p}`);
      }
      for (const p of Object.keys(r.params ?? {})) {
        assert.ok(r.path.includes(`:${p}`), `${r.name} declares unused param ${p}`);
      }
    }
  });
});

describe("resolvePath / routeUrl", () => {
  test("substitutes and encodes params", () => {
    assert.equal(resolvePath("/chats/:chat_id", { chat_id: "a b/c" }), "/chats/a%20b%2Fc");
  });

  test("throws on a missing param", () => {
    assert.throws(() => resolvePath("/chats/:chat_id", {}), /Missing path parameter/);
  });

  test("builds a full URL with query string", () => {
    const route = ROUTES.find((r) => r.name === "listChats");
    const url = routeUrl(route, { query: { page: 2, page_size: 10, empty: "" } });
    assert.equal(url, `${HOSTS.chat}/api/v2/chats/all?page=2&page_size=10`);
  });

  test("rejects an unknown group", () => {
    assert.throws(() => routeUrl({ group: "nope", path: "/x" }), /Unknown group/);
  });
});

describe("tool builder", () => {
  const tools = buildAllTools();

  test("builds one tool per route", () => {
    assert.equal(Object.keys(tools).length, ROUTES.length);
  });

  test("names are group-qualified", () => {
    assert.ok(tools["chats.getChat"]);
    assert.ok(tools["completions.createCompletion"].stream);
  });

  test("url() renders template placeholders when params are absent", () => {
    const url = tools["chats.getChat"].url();
    assert.ok(url.includes("{chat_id}"), url);
  });

  test("schema marks required fields", () => {
    const s = tools["chats.getChat"].schema;
    assert.equal(s.type, "object");
    assert.ok(s.required.includes("chat_id"));
    const opt = tools["chats.listChats"].schema;
    assert.ok(!opt.required.includes("page"));
  });

  test("manifest covers every tool", () => {
    const m = toolsManifest();
    assert.equal(m.length, ROUTES.length);
    assert.equal(new Set(m.map((t) => t.name)).size, ROUTES.length);
    for (const t of m) assert.equal(typeof t.description, "string");
  });

  test("guarded flag matches the site's substring semantics", () => {
    const t = buildTool({ group: "chats", path: "/chats/all", method: "GET", name: "x", desc: "x" });
    assert.equal(t.guarded, true);
    assert.equal(GUARDED_PREFIXES.length > 0, true);
    assert.equal(isGuarded({ group: "models", path: "/models/" }), false);
  });
});
