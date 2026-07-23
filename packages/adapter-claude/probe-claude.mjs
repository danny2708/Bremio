import { query } from "@anthropic-ai/claude-agent-sdk";

async function run() {
  console.log("=== Testing Claude Agent SDK ===");
  try {
    let sessionId1 = null;
    console.log("Turn 1: starting query...");
    for await (const msg of query({
      prompt: "Remember secret code ALPHA-999. Reply with ONLY 'OK'.",
      options: {
        maxTurns: 2,
      }
    })) {
      if (msg.type === "result") {
        sessionId1 = msg.session_id;
        console.log("Turn 1 completed. Session ID:", sessionId1, "Result:", msg.result);
      }
    }

    if (sessionId1) {
      console.log("\nTurn 2: resuming session", sessionId1);
      let foundSecret = false;
      for await (const msg of query({
        prompt: "What was the secret code I told you earlier?",
        options: {
          resume: sessionId1,
          maxTurns: 2,
        }
      })) {
        if (msg.type === "result") {
          console.log("Turn 2 completed. Session ID:", msg.session_id, "Result:", msg.result);
          if (msg.result && msg.result.includes("ALPHA-999")) {
            foundSecret = true;
          }
        }
      }
      console.log("Preserved earlier turn secret:", foundSecret);

      console.log("\nTurn 3: testing invalid session ID...");
      try {
        for await (const msg of query({
          prompt: "Hello",
          options: {
            resume: "invalid-session-id-12345",
            maxTurns: 2,
          }
        })) {
          console.log("Invalid session msg:", msg.type);
        }
      } catch (err) {
        console.log("Invalid session threw error:", err.message);
      }
    }
  } catch (err) {
    console.error("Claude probe error:", err);
  }
}

run();
