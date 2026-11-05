// Test-writing verification: the agent's tests must pass on the real
// implementation and fail on every mutant. A suite that kills no mutant
// is not a test of the stack.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const testFile = "test/stack.test.mjs";
const target = "src/stack.mjs";
if (!existsSync(testFile)) {
  console.error(`missing ${testFile}`);
  process.exit(1);
}
// A parent `node --test` sets NODE_TEST_CONTEXT, which makes a child report
// to it instead of exiting non-zero on failure; the child must be standalone.
const env = { ...process.env };
delete env.NODE_TEST_CONTEXT;
const runTests = () => spawnSync(process.execPath, ["--test", testFile], { encoding: "utf8", env });

const original = readFileSync(target, "utf8");
const real = runTests();
if (real.status !== 0) {
  console.error("tests fail against the real implementation");
  console.error(real.stdout.slice(-2000));
  process.exit(1);
}
const mutantsDir = path.join("__bench__", "mutants");
const survivors = [];
try {
  for (const name of readdirSync(mutantsDir).sort()) {
    copyFileSync(path.join(mutantsDir, name), target);
    if (runTests().status === 0) survivors.push(name);
  }
} finally {
  writeFileSync(target, original);
}
if (survivors.length > 0) {
  console.error(`mutants survived: ${survivors.join(", ")}`);
  process.exit(1);
}
console.log("all mutants killed");
