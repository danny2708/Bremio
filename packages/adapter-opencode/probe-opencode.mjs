import { spawn } from "node:child_process";
import readline from "node:readline";

async function runOpencode(args) {
  return new Promise((resolve) => {
    const child = spawn("opencode", args, { cwd: process.cwd(), shell: true });
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

    child.on("close", (code) => {
      resolve({ code, stdout, stderr, events });
    });
  });
}

async function probe() {
  console.log("=== Testing OpenCode Session Resume ===");

  console.log("\nTurn 1: opencode run '...' --format json ...");
  const res1 = await runOpencode([
    "run",
    "Remember secret string GAMMA-555. Reply ONLY 'OK'.",
    "--format", "json"
  ]);

  console.log("Turn 1 exit code:", res1.code);
  console.log("Emitted event types:", Array.from(new Set(res1.events.map(e => e.type))));

  let sessionId = null;
  for (const ev of res1.events) {
    if (ev.session_id) sessionId = ev.session_id;
    if (ev.sessionId) sessionId = ev.sessionId;
    if (ev.type === "session" && ev.id) sessionId = ev.id;
    if (ev.session && ev.session.id) sessionId = ev.session.id;
    if (JSON.stringify(ev).includes("session")) {
      console.log("Session event match:", JSON.stringify(ev));
    }
  }

  console.log("Extracted OpenCode Session ID:", sessionId);

  if (sessionId) {
    console.log(`\nTurn 2: opencode run '...' --session ${sessionId} --format json ...`);
    const res2 = await runOpencode([
      "run",
      "What was the secret string I told you earlier?",
      "--session", sessionId,
      "--format", "json"
    ]);

    console.log("Turn 2 exit code:", res2.code);
    console.log("Turn 2 stdout snippet:", res2.stdout.slice(-500).trim());

    let foundSecret = res2.stdout.includes("GAMMA-555");
    console.log("Preserved earlier turn secret:", foundSecret);
  }

  console.log("\nTurn 3: opencode run with invalid session ID...");
  const res3 = await runOpencode([
    "run",
    "Hello",
    "--session", "invalid-opencode-session-9999",
    "--format", "json"
  ]);
  console.log("Invalid session exit code:", res3.code);
  console.log("Invalid session stderr/stdout:", res3.stderr.trim() || res3.stdout.trim());
}

probe();
