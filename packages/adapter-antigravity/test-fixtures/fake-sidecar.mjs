import readline from "node:readline";

if (process.argv.includes("--health")) {
  console.log(JSON.stringify({ status: "ok", detail: "fake sidecar" }));
  process.exit(0);
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const [line] = await Array.fromAsync(rl);
const request = JSON.parse(line);
const base = { runId: request.runId, ts: Date.now() };
console.log(JSON.stringify({
  type: "tool_use",
  ...base,
  name: "run_command",
  input: { command: "npm.cmd test" },
}));
console.log(JSON.stringify({
  type: "tool_result",
  ...base,
  name: "run_command",
  ok: true,
  exitCode: 0,
}));
console.log(JSON.stringify({
  type: "message",
  ...base,
  role: "assistant",
  text: `permission=${request.permission}`,
}));
console.log(JSON.stringify({
  type: "usage",
  ...base,
  inputTokens: 12,
  outputTokens: 4,
}));
console.log(JSON.stringify({
  type: "completed",
  ...base,
  outcome: { status: "completed", finalText: "done" },
}));
