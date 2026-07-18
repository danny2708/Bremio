#!/usr/bin/env node
/**
 * Runs the Ink render smoke in a child process and grades it by its verdict
 * line.
 *
 * Ink's exit cleanup trips a libuv assertion on Windows when it tears down
 * against the fake stdin the smoke has to supply (raw mode needs a TTY-like
 * stream). That crash happens after the assertions have already run, so the
 * child's exit code is unusable — this wrapper reads the verdict instead.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const child = spawn(
  process.execPath,
  [path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs"), "src/tui/smoke.tsx"],
  { cwd: path.join(repoRoot, "apps", "cli"), stdio: ["ignore", "pipe", "pipe"] },
);

let output = "";
child.stdout.on("data", (chunk) => {
  output += chunk.toString();
  process.stdout.write(chunk);
});
child.stderr.on("data", (chunk) => {
  output += chunk.toString();
});

child.on("close", () => {
  if (output.includes("TUI smoke passed.")) process.exit(0);
  console.error("TUI smoke did not report success.");
  process.exit(1);
});
