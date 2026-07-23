import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunStore } from "@bremio/daemon";
import { listSessionsCommand, sessionCommandFromCli, showSessionCommand } from "./session";

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
    store.appendEvent(run.id, "message", { message: "analyzing schema" });
    store.appendEvent(run.id, "tool_use", { name: "read", input: { file_path: "src/db.ts" } });
    store.appendEvent(run.id, "completed", { message: "done" });
    store.updateRun(run.id, { status: "completed" });
    store.close();

    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((msg) => logs.push(String(msg)));

    const code = await showSessionCommand({ id: run.sessionId!, databasePath: dbPath });
    expect(code).toBe(0);

    const output = logs.join("\n");
    expect(output).toContain("Turn 1");
    expect(output).toContain("refactor database client");
    expect(output).toContain("analyzing schema");
    expect(output).toContain("→ read src/db.ts");
    expect(output).toContain("completed");

    // Order check: Prompt -> Process -> Outcome
    const promptIdx = output.indexOf("refactor database client");
    const processIdx = output.indexOf("analyzing schema");
    const outcomeIdx = output.indexOf("Outcome:");
    expect(promptIdx).toBeLessThan(processIdx);
    expect(processIdx).toBeLessThan(outcomeIdx);
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
});
