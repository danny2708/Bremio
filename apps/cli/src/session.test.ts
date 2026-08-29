import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunStore } from "@bremio/daemon";
import {
  configSetCommand,
  listSessionsCommand,
  resolveContinuationMode,
  resolveSessionIdentity,
  sessionCommandFromCli,
  showSessionCommand,
} from "./session";

describe("A3-T1: bremio session list and bremio session show", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "bremio-session-test-"));
    dbPath = path.join(tmpDir, "bremio.db");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it("1. list shows a seeded session with its turn count", async () => {
    const store = await RunStore.open(dbPath);
    const repoPath = path.join(tmpDir, "my-repo");
    await fs.mkdir(repoPath, { recursive: true });

    // Seed a run (creates an implicit session)
    const run1 = store.createRun({
      id: "run-seeded-1",
      mode: "single",
      repositoryPath: repoPath,
      prompt: "add user authentication endpoint",
    });
    store.updateRun(run1.id, { status: "completed" });

    // Seed a second turn in the same session
    store.createRun({
      id: "run-seeded-2",
      mode: "single",
      repositoryPath: repoPath,
      prompt: "add tests for authentication endpoint",
      sessionId: run1.sessionId,
    });
    store.close();

    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((msg) => logs.push(String(msg)));

    const code = await listSessionsCommand({ repoPath, databasePath: dbPath });
    expect(code).toBe(0);

    const output = logs.join("\n");
    expect(output).toContain(run1.sessionId);
    expect(output).toContain("add user authentication endpoint");
    expect(output).toContain("2 turns");
  });

  it("2. show renders prompt, process and outcome in order", async () => {
    const store = await RunStore.open(dbPath);
    const repoPath = path.join(tmpDir, "my-repo");

    const run = store.createRun({
      id: "run-show-1",
      mode: "single",
      repositoryPath: repoPath,
      prompt: "refactor database client",
    });
    store.appendEvent(run.id, "tool_use", { name: "read", input: { file_path: "src/db.ts" } });
    store.appendEvent(run.id, "message", { text: "analyzing schema" });
    store.appendEvent(run.id, "completed", { message: "done" });
    store.updateRun(run.id, { status: "completed" });
    store.close();

    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((msg) => logs.push(String(msg)));

    const code = await showSessionCommand({ id: run.sessionId!, databasePath: dbPath });
    expect(code).toBe(0);

    const output = logs.join("\n");
    expect(output).toContain("turn 1");
    expect(output).toContain("refactor database client");
    expect(output).toContain("→ read src/db.ts");
    expect(output).toContain("completed");
    // The agent's answer, which the transcript never used to print at all.
    expect(output).toContain("analyzing schema");

    // Order: what the user asked -> the work -> the answer -> the outcome.
    // The answer sits after the work and before the status line, so a long
    // tool log cannot bury it and the status cannot be mistaken for a reply.
    const promptIdx = output.indexOf("refactor database client");
    const workIdx = output.indexOf("→ read src/db.ts");
    const answerIdx = output.lastIndexOf("analyzing schema");
    const outcomeIdx = output.lastIndexOf("completed");
    expect(promptIdx).toBeLessThan(workIdx);
    expect(workIdx).toBeLessThan(answerIdx);
    expect(answerIdx).toBeLessThan(outcomeIdx);
  });

  it("3. an unknown id exits non-zero with a naming message", async () => {
    const errorLogs: string[] = [];
    vi.spyOn(console, "error").mockImplementation((msg) => errorLogs.push(String(msg)));

    const unknownId = "ses-unknown-9999";
    const code = await showSessionCommand({ id: unknownId, databasePath: dbPath });
    expect(code).not.toBe(0);

    const output = errorLogs.join("\n");
    expect(output).toContain(unknownId);
    expect(output).toMatch(/unknown session|not found/i);
  });

  it("CLI session subcommand routes list and show correctly with --json", async () => {
    const store = await RunStore.open(dbPath);
    const repoPath = path.join(tmpDir, "json-repo");

    const run = store.createRun({
      id: "run-json-1",
      mode: "single",
      repositoryPath: repoPath,
      prompt: "json prompt test",
    });
    store.updateRun(run.id, { status: "completed" });
    store.close();

    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((msg) => logs.push(String(msg)));

    const codeList = await sessionCommandFromCli(
      { repo: repoPath, json: true, db: dbPath },
      ["session", "list"],
    );
    expect(codeList).toBe(0);
    const jsonList = JSON.parse(logs[0]!);
    expect(jsonList.sessions).toHaveLength(1);
    expect(jsonList.sessions[0].id).toBe(run.sessionId!);

    logs.length = 0;
    const codeShow = await sessionCommandFromCli(
      { json: true, db: dbPath },
      ["session", "show", run.sessionId!],
    );
    expect(codeShow).toBe(0);
    const jsonShow = JSON.parse(logs[0]!);
    expect(jsonShow.session.id).toBe(run.sessionId!);
    expect(jsonShow.session.turns[0].prompt).toBe("json prompt test");
  });

  it("CLI session continue subcommand returns error when session is unknown", async () => {
    const errorLogs: string[] = [];
    vi.spyOn(console, "error").mockImplementation((msg) => errorLogs.push(String(msg)));

    const code = await sessionCommandFromCli(
      { db: dbPath },
      ["session", "continue", "unknown-session-id", "follow up prompt"],
    );
    expect(code).toBe(1);
    expect(errorLogs.join("\n")).toContain("session not found: unknown-session-id");
  });

  it("CLI session fork subcommand forks session and outputs JSON (S10-T14)", async () => {
    const s = await RunStore.open(dbPath);
    const r0 = s.createRun({ id: "cli-fork-r0", mode: "single", repositoryPath: "/tmp/repo", prompt: "turn 0" });
    s.createRun({ id: "cli-fork-r1", mode: "single", repositoryPath: "/tmp/repo", prompt: "turn 1", sessionId: r0.sessionId! });
    s.close();

    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((msg) => logs.push(String(msg)));

    const code = await sessionCommandFromCli(
      { json: true, db: dbPath, turn: "0" },
      ["session", "fork", r0.sessionId!],
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(logs[0]!);
    expect(parsed.parentSessionId).toBe(r0.sessionId!);
    expect(parsed.forkedFromTurn).toBe(0);
    expect(parsed.turns).toHaveLength(1);
  });

  describe("S6-T3: bremio session config-set (change config mid-session)", () => {
    let tmpDir: string;
    let dbPath: string;

    beforeEach(async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "bremio-config-set-"));
      dbPath = path.join(tmpDir, "bremio.db");
    });

    afterEach(async () => {
      vi.restoreAllMocks();
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    });

    it("updates a single config field and preserves others", async () => {
      const store = await RunStore.open(dbPath);
      const repoPath = path.join(tmpDir, "repo");
      await fs.mkdir(repoPath, { recursive: true });

      const run = store.createRun({
        id: "cfg-seed-1",
        mode: "single",
        repositoryPath: repoPath,
        prompt: "seed",
        leadProvider: "claude",
      });
      const sessionId = run.sessionId!;
      store.close();

      const logs: string[] = [];
      vi.spyOn(console, "log").mockImplementation((msg) => logs.push(String(msg)));

      const code = await configSetCommand({
        id: sessionId,
        model: "claude-sonnet-5",
        reason: "switching model mid-session",
        databasePath: dbPath,
      });

      expect(code).toBe(0);
      const output = logs.join("\n");
      expect(output).toContain("Session config updated");
      expect(output).toContain("claude-sonnet-5");
      expect(output).toContain("switching model mid-session");

      // Verify the revision was appended and the mode/lead are preserved.
      const store2 = await RunStore.open(dbPath);
      try {
        const config = store2.getSessionConfig(sessionId);
        expect(config).toBeDefined();
        expect(config!.revision).toBe(2);
        expect(config!.model).toBe("claude-sonnet-5");
        expect(config!.leadAgentId).toBe("claude");
        expect(config!.changeReason).toBe("switching model mid-session");
      } finally {
        store2.close();
      }
    });

    it("returns exit code 1 for a non-existent session", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const code = await configSetCommand({
        id: "nonexistent",
        reason: "test",
        databasePath: dbPath,
      });
      expect(code).toBe(1);
    });

    it("dispatches config-set from sessionCommandFromCli", async () => {
      const store = await RunStore.open(dbPath);
      const repoPath = path.join(tmpDir, "repo2");
      await fs.mkdir(repoPath, { recursive: true });

      const run = store.createRun({
        id: "cfg-dispatch-1",
        mode: "single",
        repositoryPath: repoPath,
        prompt: "dispatch test",
        leadProvider: "claude",
      });
      const sessionId = run.sessionId!;
      store.close();

      const logs: string[] = [];
      vi.spyOn(console, "log").mockImplementation((msg) => logs.push(String(msg)));

      const code = await sessionCommandFromCli(
        { db: dbPath, model: "claude-sonnet-5", reason: "dispatch test" },
        ["session", "config-set", sessionId],
      );

      expect(code).toBe(0);
      expect(logs.join("\n")).toContain("Session config updated");
    });
  });
});

describe("resuming a session must not change which agent runs it", () => {
  const AGENTS = ["claude", "codex", "antigravity", "opencode"];

  it.each(["antigravity", "codex", "opencode", "claude"])(
    "resumes a session recorded as %s on that same agent",
    (agent) => {
      const result = resolveSessionIdentity({
        sessionId: "ses-1",
        turns: [{ leadProvider: agent, mode: "single" }],
        availableAgentIds: AGENTS,
      });
      expect(result).toEqual({ ok: true, mode: "single", primaryAgent: agent });
    },
  );

  it("never derives the agent from a provider-reported model string", () => {
    // The old code was `latestTurn?.model?.split("/")[0] ?? "claude"`. A turn
    // carrying a model but no recorded agent must refuse, not parse it.
    const result = resolveSessionIdentity({
      sessionId: "ses-2",
      turns: [{ mode: "single", model: "gemini-3.5-flash" }],
      availableAgentIds: AGENTS,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toContain("was not recorded");
    // The model string must not leak into the outcome in any form.
    expect(JSON.stringify(result)).not.toContain("gemini");
  });

  it("does not fall back to claude when the agent is unknown", () => {
    const result = resolveSessionIdentity({
      sessionId: "ses-3",
      turns: [{ mode: "single" }],
      availableAgentIds: AGENTS,
    });
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty("primaryAgent");
  });

  it("keeps a Team session in Team mode instead of degrading it to Single", () => {
    const result = resolveSessionIdentity({
      sessionId: "ses-4",
      turns: [{ leadProvider: "codex", mode: "team", workerProviders: ["antigravity"] }],
      availableAgentIds: AGENTS,
    });
    expect(result).toEqual({
      ok: true,
      mode: "team",
      primaryAgent: "codex",
      workerAgent: "antigravity",
      workerAgents: ["antigravity"],
    });
  });

  it("refuses rather than guessing when collaboration mode was never recorded", () => {
    const result = resolveSessionIdentity({
      sessionId: "ses-5",
      turns: [{ leadProvider: "codex" }],
      availableAgentIds: AGENTS,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toContain("collaboration mode is missing");
  });

  it("refuses when the original provider is unavailable, and says it did not substitute", () => {
    const result = resolveSessionIdentity({
      sessionId: "ses-6",
      turns: [{ leadProvider: "antigravity", mode: "single" }],
      availableAgentIds: ["claude", "codex"],
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toContain("antigravity");
    expect(result.error).toContain("not available");
    expect(result.error).toContain("not switched to another provider");
  });

  it("refuses when the Team worker is no longer available", () => {
    const result = resolveSessionIdentity({
      sessionId: "ses-7",
      turns: [{ leadProvider: "codex", mode: "team", workerProviders: ["antigravity"] }],
      availableAgentIds: ["claude", "codex"],
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toContain("worker agent");
  });

  it("refuses a session with no turns rather than inventing a starting point", () => {
    const result = resolveSessionIdentity({
      sessionId: "ses-8",
      turns: [],
      availableAgentIds: AGENTS,
    });
    expect(result.ok).toBe(false);
  });

  it("resolves from the latest turn", () => {
    const result = resolveSessionIdentity({
      sessionId: "ses-9",
      turns: [
        { leadProvider: "antigravity", mode: "single" },
        { leadProvider: "codex", mode: "single" },
      ],
      availableAgentIds: AGENTS,
    });
    expect(result).toMatchObject({ ok: true, primaryAgent: "codex" });
  });
});

describe("S6-T2 follow-up: an approved transition must change the next continue", () => {
  // evaluateSessionTransition (packages/policy) persists an approved move as
  // `collaborationState` on the session config — a different table from the
  // run history resolveSessionIdentity reads. Before this, nothing consulted
  // it: `bremio session continue` kept resuming in whatever mode the
  // *previous run* used, so approving Solo→Co-lab was observably a no-op.

  it("keeps resuming in the last turn's mode when no transition was ever recorded", () => {
    const identity = { mode: "single" as const };
    expect(resolveContinuationMode(identity, undefined)).toEqual(identity);
  });

  it("switches an approved Solo→Co-lab transition to Team on the next continue", () => {
    const identity = { mode: "single" as const };
    expect(resolveContinuationMode(identity, "colab")).toEqual({ mode: "team" });
  });

  it("carries the prior worker forward rather than re-picking one", () => {
    const identity = { mode: "single" as const, workerAgent: "antigravity" };
    expect(resolveContinuationMode(identity, "colab")).toEqual({
      mode: "team",
      workerAgent: "antigravity",
    });
  });

  it("switches an approved Co-lab→Solo transition to Single, dropping the worker", () => {
    const identity = { mode: "team" as const, workerAgent: "codex" };
    expect(resolveContinuationMode(identity, "solo")).toEqual({ mode: "single" });
  });

  it("treats a pending proposal as still on its stable side", () => {
    // effectiveMode(proposed-colab) is "solo": nothing was approved yet.
    const identity = { mode: "single" as const };
    expect(resolveContinuationMode(identity, "proposed-colab")).toEqual({ mode: "single" });
  });

  it("carries all prior workers forward in Co-lab continuation (S10-T7)", () => {
    const identity = { mode: "single" as const, workerAgents: ["antigravity", "codex"], workerAgent: "antigravity" };
    expect(resolveContinuationMode(identity, "colab")).toEqual({
      mode: "team",
      workerAgents: ["antigravity", "codex"],
      workerAgent: "antigravity",
    });
  });
});
