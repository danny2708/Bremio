#!/usr/bin/env node
// Stand-in for the `agy` CLI so adapter tests never spawn the real binary
// (which would cost subscription quota and require a signed-in machine).
const args = process.argv.slice(2);

if (args.includes("--version")) {
  console.log("1.1.4");
  process.exit(0);
}

const promptIndex = args.indexOf("-p");
const prompt = promptIndex >= 0 ? (args[promptIndex + 1] ?? "") : "";

if (prompt.includes("FAIL_PLEASE")) {
  process.stderr.write("simulated agy failure\n");
  process.exit(3);
}

// Real `agy --print` emits prose across several lines.
console.log("I will inspect the workspace.");
console.log(`Working in ${args[args.indexOf("--add-dir") + 1] ?? "(no workspace)"}.`);
console.log("Done: task complete.");
process.exit(0);
