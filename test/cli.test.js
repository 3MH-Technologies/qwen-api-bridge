import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));

function run(...args) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
    return { code: 0, stdout };
  } catch (e) {
    return { code: e.status, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

describe("cli", () => {
  test("prints help and exits 0", () => {
    const r = run("--help");
    assert.equal(r.code, 0);
    assert.match(r.stdout, /Usage: qwen <command>/);
    assert.match(r.stdout, /auth-import/);
  });

  test("prints the package version", () => {
    const r = run("--version");
    assert.equal(r.code, 0);
    assert.match(r.stdout.trim(), /^\d+\.\d+\.\d+/);
  });

  test("unknown command exits 1", () => {
    const r = run("definitely-not-a-command");
    assert.equal(r.code, 1);
    assert.match(r.stderr, /Unknown command/);
  });

  test("no command prints usage and exits 0", () => {
    const r = run();
    assert.equal(r.code, 0);
    assert.match(r.stdout, /Usage: qwen/);
  });

  test("tools-json emits the full manifest", () => {
    const r = run("tools-json");
    assert.equal(r.code, 0);
    const manifest = JSON.parse(r.stdout);
    assert.ok(Array.isArray(manifest));
    assert.ok(manifest.length >= 80);
    for (const t of manifest) {
      assert.match(t.name, /^[a-z]+\.[a-zA-Z]+$/);
      assert.ok(t.schema.type === "object");
    }
  });

  test("routes marks verified and inferred entries", () => {
    const r = run("routes");
    assert.equal(r.code, 0);
    assert.match(r.stdout, /\[verified\]/);
    assert.match(r.stdout, /\[inferred\]/);
  });

  test("auth-import accepts a cookie string and refuses without one", () => {
    const bad = run("auth-import");
    assert.equal(bad.code, 1);
  });
});
