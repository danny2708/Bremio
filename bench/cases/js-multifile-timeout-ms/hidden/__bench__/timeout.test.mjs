import { test } from "node:test";
import assert from "node:assert/strict";
import { defaults } from "../src/config.mjs";
import { createClient } from "../src/client.mjs";
import { parseArgs } from "../src/cli.mjs";

test("defaults renamed and converted", () => {
  assert.equal(defaults.timeoutMs, 30000);
  assert.equal("timeout" in defaults, false);
});
test("describe defaults", () => assert.equal(createClient().describe(), "timeoutMs=30000 retries=2"));
test("describe override", () => assert.equal(createClient({ timeoutMs: 500 }).describe(), "timeoutMs=500 retries=2"));
test("old option rejected", () => assert.throws(() => createClient({ timeout: 5 }), /timeoutMs/));
test("cli flag renamed", () => assert.deepEqual(parseArgs(["--timeout-ms", "250"]), { timeoutMs: 250 }));
test("old cli flag rejected", () => assert.throws(() => parseArgs(["--timeout", "5"])));
test("retries unchanged", () => assert.deepEqual(parseArgs(["--retries", "3"]), { retries: 3 }));
