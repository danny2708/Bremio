import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "../src/app.mjs";

test("validate.mjs exports both helpers", async () => {
  const v = await import("../src/validate.mjs");
  assert.equal(v.isEmail("a@b.co"), true);
  assert.equal(v.isEmail("nope"), false);
  assert.equal(v.isNonEmpty("  x "), true);
  assert.equal(v.isNonEmpty("   "), false);
});

test("app.mjs imports instead of defining", async () => {
  const src = await readFile(new URL("../src/app.mjs", import.meta.url), "utf8");
  assert.match(src, /from\s+["']\.\/validate\.mjs["']/);
  assert.doesNotMatch(src, /function\s+isEmail/);
  assert.doesNotMatch(src, /function\s+isNonEmpty/);
});

test("register behaviour unchanged", () => {
  assert.deepEqual(register({ name: "Ann", email: "ann@example.com" }), { ok: true, errors: [] });
  assert.deepEqual(register({ name: " ", email: "bad" }), {
    ok: false,
    errors: ["name is required", "email is invalid"],
  });
});
