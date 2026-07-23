import { describe, expect, it } from "vitest";
import { assembleTurnContext } from "./context-assembler";

describe("B2: Context Assembler", () => {
  it("1. assembles exact prompt content for a fixed history with summaries and verbatim turns", () => {
    const res = assembleTurnContext({
      sessionTitle: "Authentication setup",
      priorTurns: [
        {
          turnIndex: 0,
          prompt: "Add login endpoint",
          summary: "Implemented POST /api/login endpoint with JWT token response.",
        },
        {
          turnIndex: 1,
          prompt: "Add user validation",
          status: "completed",
          finalText: "User validation schema added to login payload.",
        },
        {
          turnIndex: 2,
          prompt: "Add rate limiting to login",
          status: "completed",
          finalText: "Rate limiting middleware configured for 5 requests/min.",
        },
      ],
      currentDiff: `diff --git a/src/auth.ts b/src/auth.ts
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -1,3 +1,5 @@
+// Rate limiting middleware
+export const rateLimiter = createRateLimiter();`,
      newPrompt: "Now also handle the error case when credentials are invalid",
      maxVerbatimTurns: 2,
    });

    const expected = `# Session History & Context

## Prior Turns

### Turn 0 (Summary)
Implemented POST /api/login endpoint with JWT token response.

### Turn 1
Prompt: Add user validation
Outcome: User validation schema added to login payload.

### Turn 2
Prompt: Add rate limiting to login
Outcome: Rate limiting middleware configured for 5 requests/min.

## Current Repository State
\`\`\`diff
diff --git a/src/auth.ts b/src/auth.ts
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -1,3 +1,5 @@
+// Rate limiting middleware
+export const rateLimiter = createRateLimiter();
\`\`\`

## Current Turn Instruction
Now also handle the error case when credentials are invalid`;

    expect(res.assembledPrompt).toBe(expected);
    expect(res.summarizedTurnCount).toBe(1);
    expect(res.verbatimTurnCount).toBe(2);
    expect(res.elidedTurnCount).toBe(0);
    expect(res.hasDiff).toBe(true);
  });

  it("2. a turn referring to a prior change sees the current diff state", () => {
    const diffContent = `diff --git a/src/server.ts b/src/server.ts
+ app.use(authRouter);`;

    const res = assembleTurnContext({
      priorTurns: [
        {
          turnIndex: 0,
          prompt: "Mount auth router",
          finalText: "Mounted router in server.ts",
        },
      ],
      currentDiff: diffContent,
      newPrompt: "Verify auth router handles CORS correctly",
    });

    expect(res.assembledPrompt).toContain("## Current Repository State");
    expect(res.assembledPrompt).toContain("app.use(authRouter);");
    expect(res.hasDiff).toBe(true);
  });

  it("3. explicitly announces elided older turns without silent truncation", () => {
    const res = assembleTurnContext({
      priorTurns: [
        {
          turnIndex: 0,
          prompt: "Initial setup",
          summary: "Created project scaffolding",
          elided: true,
        },
        {
          turnIndex: 1,
          prompt: "Add database connection",
          summary: "Connected SQLite database",
          elided: true,
        },
        {
          turnIndex: 2,
          prompt: "Add migration",
          finalText: "Added schema migration",
        },
      ],
      newPrompt: "Add seed script",
      maxVerbatimTurns: 1,
    });

    expect(res.assembledPrompt).toContain("[Elided Turn 0 (Summary: Created project scaffolding)]");
    expect(res.assembledPrompt).toContain("[Elided Turn 1 (Summary: Connected SQLite database)]");
    expect(res.assembledPrompt).toContain("### Turn 2\nPrompt: Add migration");
    expect(res.elidedTurnCount).toBe(2);
  });

  it("4. renders clean output for the initial turn (empty history, no diff)", () => {
    const res = assembleTurnContext({
      priorTurns: [],
      newPrompt: "Build initial feature",
    });

    const expected = `# Session History & Context

No prior turns in this session.

## Current Repository State
No uncommitted changes in workspace.

## Current Turn Instruction
Build initial feature`;

    expect(res.assembledPrompt).toBe(expected);
    expect(res.verbatimTurnCount).toBe(0);
    expect(res.summarizedTurnCount).toBe(0);
    expect(res.elidedTurnCount).toBe(0);
    expect(res.hasDiff).toBe(false);
  });
});
