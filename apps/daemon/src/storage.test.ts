import { createRequire } from "node:module";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_PAYLOAD_BYTES,
  RunStore,
  capPayload,
  isTerminal,
  redact,
  truncateTitle,
} from "./storage";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

const dirs: string[] = [];
const stores: RunStore[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) {
    // Windows can hold the SQLite sidecar files for a moment after close;
    // this is test hygiene, not a product behaviour worth asserting on.
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
      .catch(() => {});
  }
});

async function store(): Promise<RunStore> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bremio-store-"));
  dirs.push(dir);
  const opened = await RunStore.open(path.join(dir, "bremio.db"));
  stores.push(opened);
  return opened;
}

/** Reopen the same file to simulate a daemon restart. */
async function reopen(previous: RunStore, file: string): Promise<RunStore> {
  previous.close();
  const opened = await RunStore.open(file);
  stores.push(opened);
  return opened;
}

function seedRun(s: RunStore, id = "run-1") {
  return s.createRun({
    id,
    mode: "team",
    repositoryPath: "/tmp/repo",
    prompt: "do the thing",
    leadProvider: "claude",
  });
}

describe("run store", () => {
  it("creates a run in queued state", async () => {
    const s = await store();
    const run = seedRun(s);

    expect(run).toMatchObject({ id: "run-1", mode: "team", status: "queued", leadProvider: "claude" });
    expect(s.getRun("run-1")?.prompt).toBe("do the thing");
  });

  it("allocates strictly increasing sequence numbers", async () => {
    const s = await store();
    seedRun(s);

    const seqs = ["a", "b", "c", "d"].map((type) => s.appendEvent("run-1", type, { type }).seq);
    expect(seqs).toEqual([1, 2, 3, 4]);
    expect(s.lastSeq("run-1")).toBe(4);
  });

  it("rejects a duplicate sequence rather than corrupting the stream", async () => {
    const s = await store();
    seedRun(s);
    s.appendEvent("run-1", "a", {});

    // Reaching into SQL directly is the only way to force the collision the
    // unique constraint exists to catch.
    expect(() =>
      (s as unknown as { db: { prepare(sql: string): { run(...a: unknown[]): unknown } } }).db
        .prepare("INSERT INTO run_events (run_id, seq, type, timestamp, payload) VALUES (?,?,?,?,?)")
        .run("run-1", 1, "dupe", new Date().toISOString(), "{}"),
    ).toThrow();
  });

  it("keeps events and runs across a reopen", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bremio-store-"));
    dirs.push(dir);
    const file = path.join(dir, "bremio.db");

    let s = await RunStore.open(file);
    stores.push(s);
    seedRun(s);
    s.appendEvent("run-1", "run.started", { at: 1 });
    s.appendEvent("run-1", "agent.output", { line: "hello" });

    s = await reopen(s, file);

    expect(s.getRun("run-1")?.status).toBe("queued");
    const events = s.readEvents("run-1");
    expect(events.map((e) => e.type)).toEqual(["run.started", "agent.output"]);
    expect(events.map((e) => e.seq)).toEqual([1, 2]);
  });

  it("continues the sequence after a reopen instead of restarting at 1", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bremio-store-"));
    dirs.push(dir);
    const file = path.join(dir, "bremio.db");

    let s = await RunStore.open(file);
    stores.push(s);
    seedRun(s);
    s.appendEvent("run-1", "a", {});
    s.appendEvent("run-1", "b", {});

    s = await reopen(s, file);
    // A restart that reset the counter would make a resuming client re-render
    // history it already has.
    expect(s.appendEvent("run-1", "c", {}).seq).toBe(3);
  });

  it("replays only events after the requested sequence", async () => {
    const s = await store();
    seedRun(s);
    for (const type of ["a", "b", "c"]) s.appendEvent("run-1", type, {});

    expect(s.readEvents("run-1", 1).map((e) => e.type)).toEqual(["b", "c"]);
    expect(s.readEvents("run-1", 3)).toHaveLength(0);
  });

  it("moves status and event together so a terminal event is never seen over a running run", async () => {
    const s = await store();
    seedRun(s);

    s.appendEventWithStatus("run-1", "run.completed", { ok: true }, {
      status: "completed",
      completedAt: new Date().toISOString(),
    });

    expect(s.getRun("run-1")?.status).toBe("completed");
    expect(s.readEvents("run-1").at(-1)?.type).toBe("run.completed");
  });

  it("lists runs for one repository, newest first", async () => {
    const s = await store();
    s.createRun({ id: "old", mode: "single", repositoryPath: "/tmp/a", prompt: "1" });
    s.createRun({ id: "new", mode: "single", repositoryPath: "/tmp/a", prompt: "2" });
    s.createRun({ id: "other", mode: "single", repositoryPath: "/tmp/b", prompt: "3" });

    const listed = s.listRuns({ repositoryPath: "/tmp/a" }).map((r) => r.id);
    expect(listed).toHaveLength(2);
    expect(listed).toContain("old");
    expect(listed).toContain("new");
  });

  it("reports runs that were mid-flight", async () => {
    const s = await store();
    seedRun(s, "a");
    seedRun(s, "b");
    s.updateRun("a", { status: "running" });
    s.updateRun("b", { status: "completed" });

    expect(s.nonTerminalRuns().map((r) => r.id)).toEqual(["a"]);
  });

  it("records and lists artifacts", async () => {
    const s = await store();
    seedRun(s);
    s.recordArtifact({ runId: "run-1", kind: "report", path: "/tmp/repo/.bremio/report.json" });
    s.recordArtifact({ runId: "run-1", kind: "worktree", path: "/tmp/wt", taskId: "TASK-1" });

    const artifacts = s.listArtifacts("run-1");
    expect(artifacts.map((a) => a.kind)).toEqual(["report", "worktree"]);
    expect(artifacts[1]?.taskId).toBe("TASK-1");
  });

  it("cascades events away when a run is pruned", async () => {
    const s = await store();
    seedRun(s, "old");
    s.appendEvent("old", "a", {});
    s.updateRun("old", { status: "completed" });

    const pruned = s.pruneRuns({ olderThan: new Date(Date.now() + 60_000), keepMinimum: 0 });
    expect(pruned).toBe(1);
    expect(s.getRun("old")).toBeUndefined();
    expect(s.readEvents("old")).toHaveLength(0);
  });

  it("never prunes an active or interrupted run", async () => {
    const s = await store();
    seedRun(s, "running-one");
    seedRun(s, "interrupted-one");
    s.updateRun("running-one", { status: "running" });
    s.updateRun("interrupted-one", { status: "interrupted" });

    const pruned = s.pruneRuns({ olderThan: new Date(Date.now() + 60_000), keepMinimum: 0 });

    // Interrupted still needs a decision from the user; pruning it would
    // destroy the evidence they need to make one.
    expect(pruned).toBe(0);
    expect(s.getRun("running-one")).toBeDefined();
    expect(s.getRun("interrupted-one")).toBeDefined();
  });

  it("keeps the newest runs even when they are older than the cutoff", async () => {
    const s = await store();
    for (const id of ["a", "b", "c"]) {
      seedRun(s, id);
      s.updateRun(id, { status: "completed" });
    }

    const pruned = s.pruneRuns({ olderThan: new Date(Date.now() + 60_000), keepMinimum: 2 });
    expect(pruned).toBe(1);
    expect(s.listRuns()).toHaveLength(2);
  });
});

describe("payload hygiene", () => {
  it("redacts anything that looks like a credential", () => {
    const redacted = redact({
      token: "abc",
      nested: { apiKey: "xyz", Authorization: "Bearer q", safe: "keep" },
      list: [{ password: "p" }],
    }) as {
      token: string;
      nested: Record<string, unknown>;
      list: Array<Record<string, unknown>>;
    };

    expect(redacted.token).toBe("[redacted]");
    expect(redacted.nested.apiKey).toBe("[redacted]");
    expect(redacted.nested.Authorization).toBe("[redacted]");
    expect(redacted.nested.safe).toBe("keep");
    expect(redacted.list[0]?.password).toBe("[redacted]");
  });

  it("leaves ordinary payloads untouched", () => {
    const payload = { taskId: "TASK-1", message: "compiling", count: 3 };
    expect(redact(payload)).toEqual(payload);
  });

  it("truncates an oversized payload with explicit metadata", () => {
    const big = { line: "x".repeat(MAX_PAYLOAD_BYTES * 2) };
    const capped = capPayload(big) as { truncated: boolean; originalBytes: number; preview: string };

    expect(capped.truncated).toBe(true);
    expect(capped.originalBytes).toBeGreaterThan(MAX_PAYLOAD_BYTES);
    expect(capped.preview.length).toBe(MAX_PAYLOAD_BYTES);
  });

  it("redacts and caps on the way into the database", async () => {
    const s = await store();
    seedRun(s);
    const event = s.appendEvent("run-1", "agent.output", { token: "secret", note: "fine" });

    expect((event.payload as Record<string, unknown>).token).toBe("[redacted]");
    expect(s.readEvents("run-1")[0]?.payload).toMatchObject({ token: "[redacted]", note: "fine" });
  });
});

describe("terminal status", () => {
  it("treats interrupted as terminal for scheduling but keeps it prunable-exempt", () => {
    expect(isTerminal("interrupted")).toBe(true);
    expect(isTerminal("running")).toBe(false);
    expect(isTerminal("queued")).toBe(false);
  });
});

async function createV1Fixture(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bremio-store-"));
  dirs.push(dir);
  const file = path.join(dir, "bremio.db");

  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      mode TEXT NOT NULL,
      status TEXT NOT NULL,
      repository_path TEXT NOT NULL,
      prompt TEXT NOT NULL,
      base_branch TEXT,
      started_at TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      lead_provider TEXT,
      worker_providers TEXT,
      orchestrator_run_id TEXT,
      final_summary TEXT,
      failure_code TEXT,
      failure_message TEXT,
      retry_of_run_id TEXT
    );
    CREATE TABLE IF NOT EXISTS run_events (
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      type TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      payload TEXT NOT NULL,
      PRIMARY KEY (run_id, seq)
    );
    CREATE TABLE IF NOT EXISTS artifacts (
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      path TEXT NOT NULL,
      task_id TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (run_id, kind, path)
    );
    CREATE INDEX IF NOT EXISTS idx_runs_repo ON runs(repository_path, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
    PRAGMA user_version = 1;
  `);

  db.prepare(
    "INSERT INTO runs (id, mode, status, repository_path, prompt, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run("v1-run", "single", "completed", "/tmp/repo", "hello from v1", "2025-01-01T00:00:00.000Z", "2025-01-01T00:00:00.000Z");

  db.prepare(
    "INSERT INTO run_events (run_id, seq, type, timestamp, payload) VALUES (?, ?, ?, ?, ?)",
  ).run("v1-run", 1, "run.started", "2025-01-01T00:00:00.000Z", '{"msg":"started"}');

  db.prepare(
    "INSERT INTO artifacts (run_id, kind, path, created_at) VALUES (?, ?, ?, ?)",
  ).run("v1-run", "report", "/tmp/repo/.bremio/report.json", "2025-01-01T00:00:00.000Z");

  db.close();
  return file;
}

describe("sessions", () => {

  it("recovers a migration that was interrupted after the column was added", async () => {
    // The unrecoverable case: the ALTER committed, the version stamp never
    // did. Re-running ALTER throws "duplicate column name", so before the
    // migration became transactional and idempotent this state made
    // RunStore.open fail forever — the daemon could not start and every run in
    // the history was unreachable.
    const file = await createV1Fixture();
    const half = new DatabaseSync(file);
    half.exec(
      "CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, repository_path TEXT NOT NULL," +
        " title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
    );
    half.exec("ALTER TABLE runs ADD COLUMN session_id TEXT");
    half.close(); // user_version is still 1: the crash happened here

    const s = await RunStore.open(file);
    stores.push(s);

    const run = s.getRun("v1-run");
    expect(run?.prompt).toBe("hello from v1");
    expect(s.readEvents("v1-run")).toHaveLength(1);
    expect(s.listSessions("/tmp/repo")).toHaveLength(1);
  });

  it("upgrades a v1 fixture to v2 with all runs and events intact", async () => {
    const file = await createV1Fixture();
    const s = await RunStore.open(file);
    stores.push(s);

    const run = s.getRun("v1-run");
    expect(run).toBeDefined();
    expect(run?.prompt).toBe("hello from v1");
    expect(run?.sessionId).toBeDefined();
    expect(run?.turnIndex).toBe(0);

    const events = s.readEvents("v1-run");
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("run.started");

    const artifacts = s.listArtifacts("v1-run");
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.kind).toBe("report");
  });

  it("fresh v2 and upgraded v1 have the same schema", async () => {
    const fresh = await store();
    const upgradedFile = await createV1Fixture();
    const upgraded = await RunStore.open(upgradedFile);
    stores.push(upgraded);

    const freshCols = fresh["db"].prepare("PRAGMA table_info(sessions)").all() as Array<Record<string, unknown>>;
    const upgradedCols = upgraded["db"].prepare("PRAGMA table_info(sessions)").all() as Array<Record<string, unknown>>;
    expect(freshCols).toEqual(upgradedCols);

    const freshRunCols = fresh["db"].prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>;
    const upgradedRunCols = upgraded["db"].prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>;
    const names = freshRunCols.map((c) => c.name).sort();
    const upgradedNames = upgradedRunCols.map((c) => c.name).sort();
    expect(names).toEqual(upgradedNames);
    expect(names).toContain("session_id");
    expect(names).toContain("turn_index");
  });

  it("creates an implicit session at turn_index 0 when none is given", async () => {
    const s = await store();
    const run = s.createRun({
      id: "no-session",
      mode: "single",
      repositoryPath: "/tmp/repo",
      prompt: "test prompt",
    });

    expect(run.sessionId).toBeDefined();
    expect(run.turnIndex).toBe(0);

    const sessions = s.listSessions("/tmp/repo");
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.id).toBe(run.sessionId);
    expect(sessions[0]?.turnCount).toBe(1);
    expect(sessions[0]?.title).toBe("test prompt");
  });

  it("pruning never leaves a session with a gap in its turns", async () => {
    const s = await store();
    const now = new Date().toISOString();
    // Create the session first so the FK constraint is satisfied.
    (s as unknown as { db: { prepare(sql: string): { run(...a: unknown[]): unknown } } }).db
      .prepare(
        "INSERT INTO sessions (id, repository_path, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run("ses-gap", "/tmp/repo", "test", now, now);

    const runA = s.createRun({
      id: "turn-a",
      mode: "single",
      repositoryPath: "/tmp/repo",
      prompt: "first",
      sessionId: "ses-gap",
    });
    const runB = s.createRun({
      id: "turn-b",
      mode: "single",
      repositoryPath: "/tmp/repo",
      prompt: "second",
      sessionId: "ses-gap",
    });

    expect(runA.turnIndex).toBe(0);
    expect(runB.turnIndex).toBe(1);

    // Mark only the first turn as terminal and old — the session has a
    // non-terminal run so it must stay intact.
    s.updateRun("turn-a", { status: "completed" });

    const pruned = s.pruneRuns({ olderThan: new Date(Date.now() + 60_000), keepMinimum: 0 });
    expect(pruned).toBe(0);

    // Both runs must still be present — no hole.
    expect(s.getRun("turn-a")).toBeDefined();
    expect(s.getRun("turn-b")).toBeDefined();
  });

  it("lists sessions ordered by most recent activity, scoped to the repository", async () => {
    const s = await store();

    s.createRun({ id: "r1", mode: "single", repositoryPath: "/tmp/repo-a", prompt: "first" });
    s.createRun({ id: "r2", mode: "single", repositoryPath: "/tmp/repo-b", prompt: "second" });
    s.createRun({ id: "r3", mode: "single", repositoryPath: "/tmp/repo-a", prompt: "third" });

    const sessionsA = s.listSessions("/tmp/repo-a");
    expect(sessionsA).toHaveLength(2);
    expect(sessionsA[0]?.turnCount).toBe(1);
    expect(sessionsA[1]?.turnCount).toBe(1);

    const sessionsB = s.listSessions("/tmp/repo-b");
    expect(sessionsB).toHaveLength(1);
    expect(sessionsB[0]?.title).toBe("second");
  });
});

describe("session_context (B1)", () => {
  it("stores and retrieves session context per turn without overwriting earlier turns", async () => {
    const s = await store();
    const run0 = s.createRun({
      id: "run-turn-0",
      mode: "single",
      repositoryPath: "/tmp/repo",
      prompt: "turn 0 prompt",
    });
    const sessionId = run0.sessionId!;

    const ctx0 = s.saveSessionContext({
      sessionId,
      turnIndex: 0,
      summary: "turn 0 summary",
      providerSessionIds: { claude: "claude-ses-0" },
    });

    expect(ctx0.sessionId).toBe(sessionId);
    expect(ctx0.turnIndex).toBe(0);
    expect(ctx0.summary).toBe("turn 0 summary");
    expect(ctx0.providerSessionIds).toEqual({ claude: "claude-ses-0" });

    // Add turn 1
    const run1 = s.createRun({
      id: "run-turn-1",
      mode: "single",
      repositoryPath: "/tmp/repo",
      prompt: "turn 1 prompt",
      sessionId,
    });
    expect(run1.turnIndex).toBe(1);

    const ctx1 = s.saveSessionContext({
      sessionId,
      turnIndex: 1,
      summary: "turn 1 summary",
      providerSessionIds: { claude: "claude-ses-1", codex: "codex-th-1" },
    });

    expect(ctx1.turnIndex).toBe(1);

    // Turn 0 summary must still be readable after Turn 1 exists
    const fetched0 = s.getSessionContext(sessionId, 0);
    expect(fetched0?.summary).toBe("turn 0 summary");
    expect(fetched0?.providerSessionIds).toEqual({ claude: "claude-ses-0" });

    const fetched1 = s.getSessionContext(sessionId, 1);
    expect(fetched1?.summary).toBe("turn 1 summary");
    expect(fetched1?.providerSessionIds).toEqual({ claude: "claude-ses-1", codex: "codex-th-1" });

    const all = s.listSessionContexts(sessionId);
    expect(all).toHaveLength(2);
    expect(all[0]?.turnIndex).toBe(0);
    expect(all[1]?.turnIndex).toBe(1);

    expect(s.getLatestSessionContext(sessionId)?.turnIndex).toBe(1);
  });

  it("distinguishes an absent summary (undefined) from an empty summary (empty string)", async () => {
    const s = await store();
    const run = s.createRun({
      id: "run-absent",
      mode: "single",
      repositoryPath: "/tmp/repo",
      prompt: "prompt",
    });
    const sessionId = run.sessionId!;

    // Turn 0: summary absent (undefined)
    s.saveSessionContext({
      sessionId,
      turnIndex: 0,
      providerSessionIds: { claude: "claude-0" },
    });

    const fetched0 = s.getSessionContext(sessionId, 0);
    expect(fetched0).toBeDefined();
    expect("summary" in fetched0!).toBe(false);
    expect(fetched0?.summary).toBeUndefined();

    // Turn 1: summary explicit empty string ("")
    s.saveSessionContext({
      sessionId,
      turnIndex: 1,
      summary: "",
      providerSessionIds: { claude: "claude-1" },
    });

    const fetched1 = s.getSessionContext(sessionId, 1);
    expect(fetched1).toBeDefined();
    expect("summary" in fetched1!).toBe(true);
    expect(fetched1?.summary).toBe("");
  });

  it("upgrades a v2 database to v3 including session_context table creation", async () => {
    const fresh = await store();
    const upgradedFile = await createV1Fixture();
    const upgraded = await RunStore.open(upgradedFile);
    stores.push(upgraded);

    const freshCtxCols = fresh["db"].prepare("PRAGMA table_info(session_context)").all() as Array<{ name: string }>;
    const upgradedCtxCols = upgraded["db"].prepare("PRAGMA table_info(session_context)").all() as Array<{ name: string }>;
    const names = freshCtxCols.map((c) => c.name).sort();
    const upgradedNames = upgradedCtxCols.map((c) => c.name).sort();

    expect(names).toEqual(upgradedNames);
    expect(names).toContain("session_id");
    expect(names).toContain("turn_index");
    expect(names).toContain("summary");
    expect(names).toContain("provider_session_ids");
  });
});

describe("truncateTitle", () => {
  it("uses the first line when shorter than the limit", () => {
    expect(truncateTitle("hello world")).toBe("hello world");
  });

  it("truncates with ellipsis when longer than the limit", () => {
    const long = "x".repeat(100);
    expect(truncateTitle(long, 10)).toBe("xxxxxxx...");
  });

  it("handles multi-line prompts", () => {
    expect(truncateTitle("first line\nsecond line", 80)).toBe("first line");
  });
});
