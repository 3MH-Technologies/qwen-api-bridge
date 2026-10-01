import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Session, baseHeaders } from "../src/session.js";

describe("Session", () => {
  test("imports a document.cookie string", () => {
    const s = new Session();
    s.importCookieString("a=1; b= 2 ; broken; c=x=y");
    assert.deepEqual(s.names(), ["a", "b", "c"]);
    assert.equal(s.cookies.b, "2");
    assert.equal(s.cookies.c, "x=y");
  });

  test("header() renders name=value pairs", () => {
    const s = new Session({ a: "1", b: "2" });
    assert.equal(s.header(), "a=1; b=2");
    assert.equal(new Session().header(), "");
  });

  test("absorb applies Set-Cookie and honours deletion", () => {
    const s = new Session({ stale: "x" });
    s.absorb("fresh=1; Path=/; HttpOnly");
    s.absorb("stale=; Max-Age=0; Path=/");
    assert.equal(s.cookies.fresh, "1");
    assert.ok(!("stale" in s.cookies));
  });

  test("absorb handles arrays and junk", () => {
    const s = new Session();
    s.absorb(["a=1", "b=2; Path=/"]);
    s.absorb(null);
    s.absorb("=novalue; Path=/");
    assert.deepEqual(s.names(), ["a", "b"]);
  });

  test("importSessionJson takes cookieString + token", () => {
    const s = new Session();
    s.importSessionJson({ cookieString: "sca=abc", token: "T" });
    assert.equal(s.cookies.sca, "abc");
    assert.equal(s.accessToken, "T");
    assert.equal(s.size, 1);
  });

  test("names() never leaks values", () => {
    const s = new Session({ secret: "hunter2" });
    assert.deepEqual(s.names(), ["secret"]);
  });

  test("baseHeaders carries browser-ish defaults", () => {
    const h = baseHeaders({ "x-extra": "1" });
    assert.equal(h.origin, "https://chat.qwen.ai");
    assert.equal(h["x-extra"], "1");
    assert.ok(h["x-request-id"]);
    assert.equal(new Set([h["x-request-id"]]).size, 1);
    assert.notEqual(h["x-request-id"], baseHeaders()["x-request-id"]);
  });
});
