import { spawn } from "node:child_process";
import readline from "node:readline";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

async function runCodex(args, prompt) {
  return new Promise((resolve, reject) => {
    const child = spawn("codex", args, { cwd: process.cwd(), shell: true });
    let stdout = "";
    let stderr = "";
    const events = [];

    const rl = readline.createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      stdout += line + "\n";
      try {
        const parsed = JSON.parse(line);
        events.push(parsed);
      } catch {}
    });

    child.stderr.on("data", (d) => { stderr += d.toString(); });

    if (prompt) {
      child.stdin.write(prompt);
      child.stdin.end();
    }

    child.on("close", (code) => {
      resolve({ code, stdout, stderr, events });
    });
  });
}

async function probe() {
  console.log("=== Testing Codex Session Resume ===");
  const outFile1 = path.join(os.tmpdir(), "codex-probe-out1.txt");

  console.log("\nTurn 1: codex exec --json ...");
  const res1 = await runCodex(
    ["exec", "--json", "--color", "never", "-C", process.cwd(), "-s", "workspace-write", "-o", outFile1],
    "Remember secret word BETA-777. Reply ONLY 'OK'."
  );

  console.log("Turn 1 exit code:", res1.code);
  const sessionInitEvent = res1.events.find(e => e.type === "thread" || e.thread_id || e.session_id || e.id || e.type === "session");
  console.log("Events containing thread/session fields:");
  for (const ev of res1.events) {
    if (JSON.stringify(ev).includes("thread") || JSON.stringify(ev).includes("session")) {
      console.log("Event:", JSON.stringify(ev));
    }
  }

  // Let's inspect all event types emitted in res1
  const types = Array.from(new Set(res1.events.map(e => e.type)));
  console.log("Emitted event types:", types);

  // Check if session_id is in any event:
  let threadId = null;
  for (const ev of res1.events) {
    if (ev.thread_id) threadId = ev.thread_id;
    if (ev.session_id) threadId = ev.session_id;
    if (ev.type === "thread.created" && ev.thread?.id) threadId = ev.thread.id;
  }
  console.log("Extracted Thread/Session ID:", threadId);

  let out1Text = "";
  try {
    out1Text = await fs.readFile(outFile1, "utf8");
    console.log("OutFile1 text:", out1Text.trim());
  } catch {}
  await fs.rm(outFile1, { force: true });

  if (threadId) {
    console.log("\nTurn 2: codex exec resume --json " + threadId + " ...");
    const outFile2 = path.join(os.tmpdir(), "codex-probe-out2.txt");
    const res2 = await runCodex(
      ["exec", "resume", threadId, "--json", "-o", outFile2],
      "What was the secret word I told you earlier?"
    );
    console.log("Turn 2 exit code:", res2.code);
    let out2Text = "";
    try {
      out2Text = await fs.readFile(outFile2, "utf8");
      console.log("Turn 2 Result:", out2Text.trim());
    } catch {}
    await fs.rm(outFile2, { force: true });

    console.log("Preserved earlier turn secret:", out2Text.includes("BETA-777"));
  }

  console.log("\nTurn 3: resuming unknown/invalid thread ID...");
  const outFile3 = path.join(os.tmpdir(), "codex-probe-out3.txt");
  const res3 = await runCodex(
    ["exec", "resume", "00000000-0000-0000-0000-000000000000", "--json", "-o", outFile3],
    "Hello"
  );
  console.log("Invalid thread exit code:", res3.code);
  console.log("Invalid thread stderr:", res3.stderr.trim() || res3.stdout.trim());
  await fs.rm(outFile3, { force: true });
}

probe();
