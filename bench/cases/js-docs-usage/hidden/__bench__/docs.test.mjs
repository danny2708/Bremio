import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
const code = await readFile(new URL("../src/duration.mjs", import.meta.url), "utf8");

function section(title) {
  const re = new RegExp(`^##\\s+${title}\\s*$([\\s\\S]*?)(?=^##\\s|(?![\\s\\S]))`, "mi");
  return re.exec(readme)?.[1] ?? null;
}

test("usage section exists", () => assert.notEqual(section("Usage"), null));
test("usage imports parseDuration in a js block", () => {
  const usage = section("Usage") ?? "";
  const blocks = [...usage.matchAll(/```js\n([\s\S]*?)```/g)].map((m) => m[1]);
  assert.ok(blocks.length > 0, "no ```js block");
  assert.ok(blocks.some((b) => /import\s*\{\s*parseDuration\s*\}/.test(b)), "no import of parseDuration");
});
test("usage lists every unit", () => {
  const usage = section("Usage") ?? "";
  for (const [unit, word] of [["h", "hour"], ["m", "minute"], ["s", "second"]]) {
    assert.ok(usage.includes(`\`${unit}\``) || new RegExp(word, "i").test(usage), `unit ${unit} missing`);
  }
});
test("errors section explains invalid input", () => {
  const errors = section("Errors");
  assert.notEqual(errors, null);
  assert.match(errors ?? "", /throw|error/i);
});
test("code unchanged", () => assert.match(code, /m: 60/));
