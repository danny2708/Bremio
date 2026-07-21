#!/usr/bin/env node
const args = process.argv.slice(2);

if (args.includes("--version")) {
  console.log("1.18.4");
  process.exit(0);
}

if (args.includes("providers") && args.includes("list")) {
  console.log("┌ Credentials");
  console.log("●  OpenCode Zen api");
  console.log("└ 1 credentials");
  console.log("");
  console.log("┌ Environment");
  console.log("●  OpenAI OPENAI_API_KEY");
  console.log("└ 1 environment variable");
  process.exit(0);
}

const isServe = args.includes("serve");

if (isServe) {
  const portIndex = args.indexOf("--port");
  const port = portIndex >= 0 ? args[portIndex + 1] : "0";
  console.error(`opencode server listening on http://127.0.0.1:${port}`);
  setTimeout(() => process.exit(0), 60_000);
  while (true) {
    await new Promise((r) => setTimeout(r, 1_000));
  }
}

const formatIndex = args.indexOf("--format");
const format = formatIndex >= 0 ? args[formatIndex + 1] : undefined;
const dirIndex = args.indexOf("--dir");
const runDir = dirIndex >= 0 ? args[dirIndex + 1] : process.cwd();

const runFlagIndex = args.indexOf("run");
const messageStart = Math.max(
  formatIndex >= 0 ? formatIndex + 2 : -1,
  dirIndex >= 0 ? dirIndex + 2 : -1,
  runFlagIndex >= 0 ? runFlagIndex + 1 : 0,
  args.indexOf("--auto") >= 0 ? args.indexOf("--auto") + 1 : 0,
  args.indexOf("--agent") >= 0 ? args.indexOf("--agent") + 2 : 0,
  args.indexOf("--model") >= 0 ? args.indexOf("--model") + 2 : 0,
);
const prompt = args.slice(messageStart).join(" ");

if (prompt.includes("FAIL_PLEASE")) {
  process.stderr.write("simulated opencode failure\n");
  process.exit(3);
}

// Echo the prompt back verbatim so a test can assert what actually crossed the
// process boundary. Newlines are the interesting part: a prompt flattened to one
// line still runs, so nothing else would catch it.
if (prompt.includes("ECHO_PROMPT")) {
  console.log(
    JSON.stringify({
      type: "text",
      timestamp: Date.now(),
      sessionID: "ses_fake00000000000000000000",
      part: { id: "prt_echo", type: "text", text: prompt },
    }),
  );
  console.log(
    JSON.stringify({
      type: "step_finish",
      timestamp: Date.now(),
      sessionID: "ses_fake00000000000000000000",
      part: { id: "prt_echo_end", reason: "stop", tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { write: 0, read: 0 } }, cost: 0 },
    }),
  );
  process.exit(0);
}

const ts = Date.now();
const sessionID = "ses_fake00000000000000000000";

const lines = [
  JSON.stringify({ type: "step_start", timestamp: ts, sessionID, part: { id: "prt_fake1", type: "step-start" } }),
  JSON.stringify({
    type: "tool_use",
    timestamp: ts + 100,
    sessionID,
    part: {
      type: "tool",
      tool: "write",
      callID: "call_fake1",
      state: {
        status: "completed",
        input: { filePath: `${runDir}/test.txt`, content: "hello" },
        output: "Wrote file successfully.",
        metadata: { filepath: `${runDir}/test.txt`, exists: false, truncated: false },
      },
    },
  }),
  JSON.stringify({
    type: "step_finish",
    timestamp: ts + 200,
    sessionID,
    part: {
      id: "prt_fake2",
      reason: "tool-calls",
      tokens: { total: 500, input: 400, output: 80, reasoning: 20, cache: { write: 0, read: 400 } },
      cost: 0,
    },
  }),
  JSON.stringify({ type: "step_start", timestamp: ts + 300, sessionID, part: { id: "prt_fake3", type: "step-start" } }),
  JSON.stringify({
    type: "text",
    timestamp: ts + 400,
    sessionID,
    part: { id: "prt_fake4", type: "text", text: "Done. Task complete.", time: { start: ts + 350, end: ts + 400 } },
  }),
  JSON.stringify({
    type: "step_finish",
    timestamp: ts + 500,
    sessionID,
    part: {
      id: "prt_fake5",
      reason: "stop",
      tokens: { total: 520, input: 5, output: 15, reasoning: 0, cache: { write: 0, read: 500 } },
      cost: 0,
    },
  }),
];

if (format === "json") {
  for (const line of lines) {
    console.log(line);
  }
} else {
  console.log("Done. Task complete.");
}

process.exit(0);
