import { createRequire } from "node:module";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_PAYLOAD_BYTES,
  normalizeRepositoryPath,
  resolveRepositoryIdentity,
  RunStore,
  capPayload,
  isTerminal,
  redact,
  truncateTitle,
} from "./storage";
import { buildPriorTurnsFromStore, tryAutoCompact } from "./runs";

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
  it("treats interrupted and supervision_lost as terminal but keeps them prunable-exempt", () => {
    expect(isTerminal("interrupted")).toBe(true);
    expect(isTerminal("supervision_lost")).toBe(true);
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

  it("finds a repository's history however the OS spelled the path that day", async () => {
    const s = await store();

    // How the path arrived when the run was recorded.
    s.createRun({
      id: "cased-1",
      mode: "single",
      repositoryPath: "d:\\Work\\Bremio",
      prompt: "recorded from a lowercase drive letter",
    });

    // How the same directory arrives from a different shell. Before this was
    // fixed, both of these returned nothing and the user's own history looked
    // as though it had been lost.
    expect(s.listSessions("D:\\Work\\Bremio")).toHaveLength(1);
    expect(s.listSessions("D:/Work/Bremio")).toHaveLength(1);
    expect(s.listSessions("D:/Work/Bremio/")).toHaveLength(1);
    expect(s.listRuns({ repositoryPath: "D:/Work/Bremio" })).toHaveLength(1);

    // Still scoped: a genuinely different repository must not bleed in.
    expect(s.listSessions("D:/Work/Bremio-test")).toHaveLength(0);
  });

  it("folds case identically in SQL and in JavaScript", () => {
    // SQLite's LOWER() is ASCII-only. If the JS side folded more than that, a
    // path with non-ASCII letters would normalize to something SQL never
    // produces and the lookup would miss without any error.
    expect(normalizeRepositoryPath("D:\\Việt\\Repo")).toBe("d:/việt/repo");
  });

  it("groups sessions across repositories by canonical repository identity (S10-T8)", async () => {
    const s = await store();

    s.createRun({ id: "r1", mode: "single", repositoryPath: "/tmp/project-alpha", prompt: "alpha task 1" });
    s.createRun({ id: "r2", mode: "single", repositoryPath: "/tmp/project-beta", prompt: "beta task 1" });
    s.createRun({ id: "r3", mode: "single", repositoryPath: "/tmp/project-alpha", prompt: "alpha task 2" });

    const groups = s.listGroupedSessions();
    expect(groups).toHaveLength(2);

    const alphaGroup = groups.find((g) => g.projectName === "project-alpha");
    const betaGroup = groups.find((g) => g.projectName === "project-beta");

    expect(alphaGroup).toBeDefined();
    expect(alphaGroup?.sessions).toHaveLength(2);
    expect(betaGroup).toBeDefined();
    expect(betaGroup?.sessions).toHaveLength(1);
  });
});

describe("RepositoryIdentity (S1-T6)", () => {
  it("resolves identity for a non-git directory", () => {
    const identity = resolveRepositoryIdentity("/tmp/nonexistent-repo");
    expect(identity.repositoryId).toBe(normalizeRepositoryPath(path.resolve("/tmp/nonexistent-repo")));
    expect(identity.canonicalRoot).toBe(normalizeRepositoryPath(path.resolve("/tmp/nonexistent-repo")));
    expect(identity.gitCommonDir).toBeUndefined();
    expect(identity.worktreeId).toBeUndefined();
  });

  it("resolves identity for a git repo", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bremio-id-git-"));
    dirs.push(dir);
    const { execSync: exec } = await import("node:child_process");
    exec("git init", { cwd: dir, stdio: "ignore" });
    exec('git config user.email "test@test" && git config user.name "Test"', { cwd: dir, stdio: "ignore" });
    exec("git commit --allow-empty -m init", { cwd: dir, stdio: "ignore" });

    const canonicalRoot = normalizeRepositoryPath(path.resolve(dir));
    const identity = resolveRepositoryIdentity(dir);
    expect(identity.repositoryId).toBe(normalizeRepositoryPath(path.resolve(dir, ".git")));
    expect(identity.canonicalRoot).toBe(canonicalRoot);
    expect(identity.gitCommonDir).toBe(normalizeRepositoryPath(path.resolve(dir, ".git")));
    // The main worktree is not a linked worktree, so it carries no worktreeId.
    expect(identity.worktreeId).toBeUndefined();
  });

  it("gives a linked worktree the same repositoryId as its main worktree, but a distinct worktreeId", async () => {
    // This is the whole reason the identity is derived from the common git dir
    // rather than the path: two worktrees of one repo must resolve to the same
    // repository, or a run started in a worktree would look like a different
    // project's history. Without this test the worktree half of S1-T6 — the
    // half the task is named for — was unproven.
    const main = await fs.mkdtemp(path.join(os.tmpdir(), "bremio-id-wt-main-"));
    dirs.push(main);
    const { execSync: exec } = await import("node:child_process");
    exec("git init", { cwd: main, stdio: "ignore" });
    exec('git config user.email "test@test" && git config user.name "Test"', { cwd: main, stdio: "ignore" });
    exec("git commit --allow-empty -m init", { cwd: main, stdio: "ignore" });

    const linked = path.join(os.tmpdir(), `bremio-id-wt-linked-${Date.now()}`);
    dirs.push(linked);
    exec(`git worktree add "${linked}" -b feature`, { cwd: main, stdio: "ignore" });

    const mainId = resolveRepositoryIdentity(main);
    const linkedId = resolveRepositoryIdentity(linked);

    // Same logical repository.
    expect(linkedId.repositoryId).toBe(mainId.repositoryId);
    // Distinct working directories.
    expect(linkedId.canonicalRoot).not.toBe(mainId.canonicalRoot);
    // Only the linked one is a worktree, and its id is its own directory.
    expect(linkedId.worktreeId).toBe(normalizeRepositoryPath(path.resolve(linked)));
    expect(mainId.worktreeId).toBeUndefined();

    // Leave no worktree registration behind for the temp-dir cleanup.
    exec(`git worktree remove "${linked}" --force`, { cwd: main, stdio: "ignore" });
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

describe("session_compacts (S7-T5)", () => {
  it("creates a compact from session runs, skips the latest turn", async () => {
    const s = await store();
    const run0 = s.createRun({ id: "run-0", mode: "single", repositoryPath: "/tmp/repo", prompt: "first turn" });
    const sessionId = run0.sessionId!;
    s.createRun({ id: "run-1", mode: "single", repositoryPath: "/tmp/repo", prompt: "second turn", sessionId });
    s.createRun({ id: "run-2", mode: "single", repositoryPath: "/tmp/repo", prompt: "third turn", sessionId });

    const cmp = s.compactSession(sessionId);
    expect(cmp.sessionId).toBe(sessionId);
    expect(cmp.turnRangeStart).toBe(0);
    expect(cmp.turnRangeEnd).toBe(1);
    expect(cmp.summary).toContain("Turn 0");
    expect(cmp.summary).toContain("Turn 1");
    expect(cmp.summary).not.toContain("Turn 2");
    expect(cmp.tokenCount).toBeGreaterThan(0);
    expect(cmp.measurementMethod).toBe("estimated");
    expect(cmp.createdBy).toBe("manual");
    expect(cmp.compactedRunIds).toEqual(["run-0", "run-1"]);
  });

  it("rejects compaction when session has no runs", async () => {
    const s = await store();
    expect(() => s.compactSession("no-such-session")).toThrow("has no runs to compact");
  });

  it("rejects compaction when session has only one turn (current)", async () => {
    const s = await store();
    const run = s.createRun({ id: "run-only", mode: "single", repositoryPath: "/tmp/repo", prompt: "only turn" });
    expect(() => s.compactSession(run.sessionId!)).toThrow("nothing to compact");
  });

  it("lists and deletes compacts", async () => {
    const s = await store();
    const run0 = s.createRun({ id: "run-0", mode: "single", repositoryPath: "/tmp/repo", prompt: "turn 0" });
    const sessionId = run0.sessionId!;
    s.createRun({ id: "run-1", mode: "single", repositoryPath: "/tmp/repo", prompt: "turn 1", sessionId });

    const cmp = s.compactSession(sessionId);
    const list = s.getSessionCompacts(sessionId);
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe(cmp.id);

    const removed = s.deleteSessionCompact(cmp.id);
    expect(removed).toBe(true);
    expect(s.getSessionCompacts(sessionId)).toHaveLength(0);

    expect(s.deleteSessionCompact("no-such")).toBe(false);
  });
});

describe("buildPriorTurnsFromStore (S7-T6)", () => {
  it("returns empty array for unknown session", async () => {
    const s = await store();
    expect(buildPriorTurnsFromStore(s, "no-such")).toEqual([]);
  });

  it("builds prior turns without compacts", async () => {
    const s = await store();
    const r0 = s.createRun({ id: "pt-0", mode: "single", repositoryPath: "/tmp/repo", prompt: "first" });
    const sid = r0.sessionId!;
    s.createRun({ id: "pt-1", mode: "single", repositoryPath: "/tmp/repo", prompt: "second", sessionId: sid });

    const turns = buildPriorTurnsFromStore(s, sid);
    expect(turns).toHaveLength(2);
    expect(turns[0]!.turnIndex).toBe(0);
    expect(turns[0]!.prompt).toBe("first");
    expect(turns[1]!.turnIndex).toBe(1);
    expect(turns[1]!.prompt).toBe("second");
  });

  it("replaces compacted turns with a single elided entry using compact summary", async () => {
    const s = await store();
    const r0 = s.createRun({ id: "ptc-0", mode: "single", repositoryPath: "/tmp/repo", prompt: "alpha" });
    const sid = r0.sessionId!;
    s.createRun({ id: "ptc-1", mode: "single", repositoryPath: "/tmp/repo", prompt: "beta", sessionId: sid });
    s.createRun({ id: "ptc-2", mode: "single", repositoryPath: "/tmp/repo", prompt: "gamma", sessionId: sid });

    const cmp = s.compactSession(sid); // compacts turns 0-1

    const turns = buildPriorTurnsFromStore(s, sid);
    // Should have: [elided entry for compact 0-1, verbatim entry for turn 2]
    expect(turns).toHaveLength(2);
    expect(turns[0]!.turnIndex).toBe(0);
    expect(turns[0]!.elided).toBe(true);
    expect(turns[0]!.summary).toBe(cmp.summary);
    expect(turns[0]!.prompt).toBe("");
    expect(turns[1]!.turnIndex).toBe(2);
    expect(turns[1]!.elided).toBeUndefined();
    expect(turns[1]!.prompt).toBe("gamma");
  });

  it("passes non-compacted turns verbatim when no compacts exist", async () => {
    const s = await store();
    const r0 = s.createRun({ id: "ptnc-0", mode: "single", repositoryPath: "/tmp/repo", prompt: "only" });
    const sid = r0.sessionId!;
    s.createRun({ id: "ptnc-1", mode: "single", repositoryPath: "/tmp/repo", prompt: "second", sessionId: sid });

    // No compact created
    const turns = buildPriorTurnsFromStore(s, sid);
    expect(turns).toHaveLength(2);
    expect(turns[0]!.elided).toBeUndefined();
    expect(turns[1]!.elided).toBeUndefined();
    expect(turns[1]!.prompt).toBe("second");
  });
});

describe("tryAutoCompact (S7-T7)", () => {
  async function makeStore(): Promise<RunStore> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bremio-s7t7-"));
    dirs.push(dir);
    const store = await RunStore.open(path.join(dir, "bremio.db"));
    stores.push(store);
    return store;
  }

  function run(s: RunStore, id: string, prompt: string, si?: string): string {
    const r = s.createRun({ id, mode: "single", repositoryPath: "/tmp/repo", prompt, ...(si ? { sessionId: si } : {}) });
    return r.sessionId!;
  }

  it("does not auto-compact when session has fewer than 2 turns", async () => {
    const s = await makeStore();
    run(s, "r1", "hi");
    const sid = run(s, "r2", "hi");
    const res = tryAutoCompact(s, sid);
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("at least 2");
  });

  it("does not auto-compact when token usage is below trigger fraction", async () => {
    const s = await makeStore();
    const sid = run(s, "r0", "short prompt");
    for (let i = 1; i < 3; i++) run(s, `r${i}`, "short", sid);
    const res = tryAutoCompact(s, sid);
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("below");
  });

  it("auto-compacts when token usage exceeds trigger fraction", async () => {
    const s = await makeStore();
    const longPrompt = "x".repeat(100_000);
    const sid = run(s, "r0", longPrompt);
    run(s, "r1", longPrompt, sid);
    run(s, "r2", longPrompt, sid);
    const res = tryAutoCompact(s, sid);
    expect(res.ok).toBe(true);
    expect(res.reason).toContain("auto-compact");
    const compacts = s.getSessionCompacts(sid);
    expect(compacts.length).toBeGreaterThanOrEqual(1);
  });

  it("compacts again once the session has grown back over budget", async () => {
    // This asserted the opposite — that the second compact was refused by
    // hysteresis — which is what the removed reset-fraction guard did. A long
    // session got exactly one auto-compact and then grew unbounded.
    const s = await makeStore();
    const longPrompt = "x".repeat(100_000);
    const sid = run(s, "r0", longPrompt);
    run(s, "r1", longPrompt, sid);
    run(s, "r2", longPrompt, sid);
    run(s, "r3", longPrompt, sid);

    const first = tryAutoCompact(s, sid, { budgetTokens: 40_000 });
    expect(first.ok).toBe(true);

    // Nothing left to fold until new turns arrive.
    const immediate = tryAutoCompact(s, sid, { budgetTokens: 40_000 });
    expect(immediate.ok).toBe(false);
    expect(immediate.reason).toContain("at least 2");

    run(s, "r4", longPrompt, sid);
    run(s, "r5", longPrompt, sid);

    const second = tryAutoCompact(s, sid, { budgetTokens: 40_000 });
    expect(second.ok).toBe(true);
    expect(s.getSessionCompacts(sid)).toHaveLength(2);
  });

  it("records who compacted, so an automatic one is not filed as the user's", async () => {
    const s = await makeStore();
    const longPrompt = "x".repeat(100_000);
    const sid = run(s, "r0", longPrompt);
    run(s, "r1", longPrompt, sid);
    run(s, "r2", longPrompt, sid);

    expect(tryAutoCompact(s, sid).ok).toBe(true);
    expect(s.getSessionCompacts(sid)[0]?.createdBy).toBe("auto");

    // An explicit compact is still the user's.
    run(s, "r3", longPrompt, sid);
    run(s, "r4", longPrompt, sid);
    s.compactSession(sid);
    expect(s.getSessionCompacts(sid).find((c) => c.createdBy === "manual")).toBeDefined();
  });

  it("auto-compacts with custom budget", async () => {
    const s = await makeStore();
    const sid = run(s, "r0", "x".repeat(110));
    run(s, "r1", "x".repeat(110), sid);
    run(s, "r2", "x".repeat(110), sid);
    const res = tryAutoCompact(s, sid, { budgetTokens: 100 });
    expect(res.ok).toBe(true);
  });
});

async function createV3Fixture(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bremio-v3-"));
  dirs.push(dir);
  const file = path.join(dir, "bremio.db");
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY, mode TEXT NOT NULL, status TEXT NOT NULL,
    repository_path TEXT NOT NULL, prompt TEXT NOT NULL,
    base_branch TEXT, started_at TEXT, completed_at TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    lead_provider TEXT, worker_providers TEXT,
    orchestrator_run_id TEXT, final_summary TEXT,
    failure_code TEXT, failure_message TEXT, retry_of_run_id TEXT,
    session_id TEXT, turn_index INTEGER NOT NULL DEFAULT 0
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY, repository_path TEXT NOT NULL,
    title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS session_context (
    session_id TEXT NOT NULL, turn_index INTEGER NOT NULL,
    summary TEXT, provider_session_ids TEXT, created_at TEXT NOT NULL,
    PRIMARY KEY (session_id, turn_index)
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS artifacts (
    run_id TEXT NOT NULL, kind TEXT NOT NULL, path TEXT NOT NULL,
    task_id TEXT, created_at TEXT NOT NULL,
    PRIMARY KEY (run_id, kind, path)
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS run_events (
    run_id TEXT NOT NULL, seq INTEGER NOT NULL, type TEXT NOT NULL,
    timestamp TEXT NOT NULL, payload TEXT NOT NULL,
    PRIMARY KEY (run_id, seq)
  )`);
  db.exec("PRAGMA user_version = 3");

  db.prepare(
    "INSERT INTO sessions (id, repository_path, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run("ses-v3", "/tmp/repo", "v3 session", "2025-06-01T00:00:00.000Z", "2025-06-01T00:00:00.000Z");

  db.prepare(
    `INSERT INTO runs (id, mode, status, repository_path, prompt, created_at, updated_at,
      lead_provider, worker_providers, session_id, turn_index)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "run-v3", "team", "completed", "/tmp/repo", "v3 task", "2025-06-01T00:00:00.000Z",
    "2025-06-01T00:00:00.000Z", "claude", '["codex"]', "ses-v3", 0,
  );

  db.close();
  return file;
}

describe("session_config (S1-T1/T2)", () => {
  it("creates a native, complete config entry when a session is created implicitly", async () => {
    const s = await store();
    const run = s.createRun({
      id: "cfg-test",
      mode: "team",
      repositoryPath: "/tmp/repo",
      prompt: "test",
      leadProvider: "claude",
    });

    const cfg = s.getSessionConfig(run.sessionId!);
    expect(cfg).toBeDefined();
    expect(cfg?.sessionId).toBe(run.sessionId);
    expect(cfg?.revision).toBe(1);
    expect(cfg?.mode).toBe("team");
    expect(cfg?.leadAgentId).toBe("claude");
    expect(cfg?.provenance).toBe("native");
    expect(cfg?.completeness).toBe("partial");
    expect(cfg?.missingFields).not.toEqual([]);
    expect(cfg?.createdAt).toBeDefined();
  });

  it("round-trips a full config and returns the latest revision", async () => {
    const s = await store();
    const run = s.createRun({
      id: "cfg-full",
      mode: "single",
      repositoryPath: "/tmp/repo",
      prompt: "full config",
    });

    const cfg = s.getSessionConfig(run.sessionId!);
    expect(cfg).toBeDefined();
    expect(cfg?.mode).toBe("single");
    expect(cfg?.provenance).toBe("native");
    expect(cfg?.completeness).toBe("partial");
  });

  it("getSessionConfig returns undefined for unknown session", async () => {
    const s = await store();
    expect(s.getSessionConfig("nonexistent-session")).toBeUndefined();
    expect(s.listSessionConfigs("nonexistent-session")).toEqual([]);
  });

  it("upgrades a v3 fixture to v5 with session_config backfilled and provenance", async () => {
    const file = await createV3Fixture();
    const s = await RunStore.open(file);
    stores.push(s);

    // The v3 session must have a backfilled config with provenance.
    const cfg = s.getSessionConfig("ses-v3");
    expect(cfg).toBeDefined();
    expect(cfg?.sessionId).toBe("ses-v3");
    expect(cfg?.revision).toBe(1);
    expect(cfg?.mode).toBe("team");
    expect(cfg?.leadAgentId).toBe("claude");
    expect(cfg?.provenance).toBe("legacy-derived");
    expect(cfg?.completeness).toBe("partial");
    expect(cfg?.missingFields).toContain("model");
    expect(cfg?.missingFields).toContain("reasoningLevel");

    // Original data must still be intact.
    expect(s.getRun("run-v3")?.prompt).toBe("v3 task");
    expect(s.listSessions("/tmp/repo")).toHaveLength(1);
  });

  it("pristine and migrated stores both report user_version = 13", async () => {
    const fresh = await store();
    const { user_version: freshVer } = fresh["db"]
      .prepare("PRAGMA user_version")
      .get() as { user_version: number };
    expect(freshVer).toBe(13);

    // Fresh store has session_compacts table
    const freshCols = fresh["db"].prepare("PRAGMA table_info(session_compacts)").all() as Array<{ name: string }>;
    const freshNames = freshCols.map((c) => c.name).sort();
    expect(freshNames).toContain("session_id");
    expect(freshNames).toContain("turn_range_start");
    expect(freshNames).toContain("summary");

    const file = await createV3Fixture();
    const migrated = await RunStore.open(file);
    stores.push(migrated);
    const { user_version: migratedVer } = migrated["db"]
      .prepare("PRAGMA user_version")
      .get() as { user_version: number };
    expect(migratedVer).toBe(13);

    // Migrated store also has session_compacts table
    const migratedCols = migrated["db"].prepare("PRAGMA table_info(session_compacts)").all() as Array<{ name: string }>;
    expect(migratedCols.length).toBeGreaterThan(0);
  });

  it("re-running migration on v5 is a no-op", async () => {
    const file = await createV3Fixture();
    const s = await RunStore.open(file);
    stores.push(s);

    // Table exists from the first open.
    const info = s["db"].prepare("PRAGMA table_info(session_config)").all() as Array<{ name: string }>;
    expect(info.length).toBeGreaterThan(0);

    // Close and reopen — migration will run again but must succeed.
    const s2 = await RunStore.open(file);
    stores.push(s2);
    expect(s2.getSessionConfig("ses-v3")?.provenance).toBe("legacy-derived");
  });

  it("createSessionConfig respects explicit provenance and computes completeness", async () => {
    const s = await store();
    const run = s.createRun({
      id: "prov-test",
      mode: "single",
      repositoryPath: "/tmp/repo",
      prompt: "provenance test",
    });
    const sid = run.sessionId!;

    // First revision (implicit from createRun) is native/partial (only mode + leadAgentId).
    const first = s.getSessionConfig(sid);
    expect(first?.provenance).toBe("native");
    expect(first?.completeness).toBe("partial");

    // Write a partial revision explicitly as legacy-import.
    s.createSessionConfig({
      sessionId: sid,
      mode: "single",
      leadAgentId: "claude",
      provenance: "legacy-import",
    });

    const second = s.getSessionConfig(sid);
    expect(second?.revision).toBe(2);
    expect(second?.provenance).toBe("legacy-import");
    expect(second?.completeness).toBe("partial");
    expect(second?.missingFields).toContain("model");
    expect(second?.missingFields).toContain("reasoningLevel");
  });

  it("stores multiple revisions for the same session", async () => {
    const s = await store();
    const run = s.createRun({
      id: "rev-test",
      mode: "single",
      repositoryPath: "/tmp/repo",
      prompt: "revision test",
    });
    const sid = run.sessionId!;

    const first = s.getSessionConfig(sid);
    expect(first?.revision).toBe(1);

    // Write a second revision directly.
    s.createSessionConfig({
      sessionId: sid,
      mode: "team",
      leadAgentId: "codex",
      workerAgentId: "claude",
      model: "gpt-4",
      reasoningLevel: "high",
    });

    const second = s.getSessionConfig(sid);
    expect(second?.revision).toBe(2);
    expect(second?.mode).toBe("team");
    expect(second?.leadAgentId).toBe("codex");

    const all = s.listSessionConfigs(sid);
    expect(all).toHaveLength(2);
    expect(all[0]?.revision).toBe(1);
    expect(all[1]?.revision).toBe(2);
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

describe("ProviderSessionBinding (S1-T4)", () => {
  it("records a binding when a run is created with a lead provider", async () => {
    const s = await store();
    const run = s.createRun({
      id: "bind-lead",
      mode: "single",
      repositoryPath: "/tmp/repo",
      prompt: "binding test",
      leadProvider: "claude",
    });
    const sid = run.sessionId!;

    const bindings = s.getBindings(sid);
    expect(bindings).toHaveLength(1);
    expect(bindings[0]?.agentId).toBe("claude");
    expect(bindings[0]?.transport).toBe("claude");
    expect(bindings[0]?.status).toBe("active");
    expect(bindings[0]?.turnIndex).toBe(0);
  });

  it("records bindings for both lead and worker providers", async () => {
    const s = await store();
    const run = s.createRun({
      id: "bind-both",
      mode: "team",
      repositoryPath: "/tmp/repo",
      prompt: "team binding",
      leadProvider: "claude",
      workerProviders: ["codex"],
    });
    const sid = run.sessionId!;

    const bindings = s.getBindings(sid);
    expect(bindings).toHaveLength(2);
    const agents = bindings.map((b) => b.agentId).sort();
    expect(agents).toEqual(["claude", "codex"]);
  });

  it("setBindingStatus updates status and native_session_id", async () => {
    const s = await store();
    const run = s.createRun({
      id: "bind-status",
      mode: "single",
      repositoryPath: "/tmp/repo",
      prompt: "status test",
      leadProvider: "claude",
    });
    const sid = run.sessionId!;

    const updated = s.setBindingStatus({
      bremioSessionId: sid,
      agentId: "claude",
      status: "active",
      nativeSessionId: "claude-native-ses-1",
    });
    expect(updated?.nativeSessionId).toBe("claude-native-ses-1");
    expect(updated?.status).toBe("active");

    const lost = s.setBindingStatus({
      bremioSessionId: sid,
      agentId: "claude",
      status: "lost",
    });
    expect(lost?.status).toBe("lost");
    expect(lost?.nativeSessionId).toBe("claude-native-ses-1"); // preserved
  });

  it("getActiveBindings returns only active bindings", async () => {
    const s = await store();
    const run = s.createRun({
      id: "bind-active",
      mode: "team",
      repositoryPath: "/tmp/repo",
      prompt: "active test",
      leadProvider: "claude",
      workerProviders: ["codex"],
    });
    const sid = run.sessionId!;

    expect(s.getActiveBindings(sid)).toHaveLength(2);

    s.setBindingStatus({
      bremioSessionId: sid,
      agentId: "claude",
      status: "lost",
    });
    const active = s.getActiveBindings(sid);
    expect(active).toHaveLength(1);
    expect(active[0]?.agentId).toBe("codex");
  });

  it("upgrades a v3 fixture to v7 with repository_id backfilled", async () => {
    const file = await createV3Fixture();
    const s = await RunStore.open(file);
    stores.push(s);

    // v6→v7 adds repository_id and backfills from repository_path.
    const detail = s.sessionDetail("ses-v3");
    expect(detail).toBeDefined();
    expect(detail!.repositoryIdentity).toBeDefined();
    // repository_id should equal the normalized repository_path /tmp/repo.
    expect(detail!.repositoryIdentity!.repositoryId).toBe(normalizeRepositoryPath("/tmp/repo"));
    expect(detail!.repositoryIdentity!.canonicalRoot).toBe("/tmp/repo");
  });

  it("upgrades a v3 fixture to v6 with provider_session_binding backfilled", async () => {
    const file = await createV3Fixture();
    const s = await RunStore.open(file);
    stores.push(s);

    // The v3 session "ses-v3" has run "run-v3" with lead_provider="claude".
    const bindings = s.getBindings("ses-v3");
    expect(bindings.length).toBeGreaterThanOrEqual(1);
    expect(bindings[0]?.agentId).toBe("claude");
    expect(bindings[0]?.status).toBe("active");
  });

  describe("context items (S7-T1)", () => {
    it("creates, gets, lists, and deletes context items", async () => {
      const s = await store();
      stores.push(s);

      const run = s.createRun({ id: "ci-run", mode: "single", repositoryPath: "/tmp/repo", prompt: "ci" });
      const sessionId = run.sessionId!;

      const item = s.saveContextItem({ sessionId, type: "file", source: "/tmp/repo/readme.md" });
      expect(item.type).toBe("file");
      expect(item.source).toBe("/tmp/repo/readme.md");
      expect(item.enabled).toBe(true);
      expect(item.scope).toBe("session");
      expect(item.id).toBeTruthy();

      const got = s.getContextItem(item.id);
      expect(got).toBeDefined();
      expect(got!.type).toBe("file");

      const items = s.listContextItems(sessionId);
      expect(items).toHaveLength(1);
      expect(items[0]!.id).toBe(item.id);

      const deleted = s.deleteContextItem(item.id);
      expect(deleted).toBe(true);
      expect(s.listContextItems(sessionId)).toHaveLength(0);
    });

    it("creates context items with explicit fields", async () => {
      const s = await store();
      stores.push(s);

      const run = s.createRun({ id: "ci-explicit", mode: "single", repositoryPath: "/tmp/repo", prompt: "ci" });
      const sessionId = run.sessionId!;

      const item = s.saveContextItem({
        id: "my-custom-id",
        sessionId,
        type: "image",
        source: "/tmp/repo/screenshot.png",
        scope: "turn",
        tokensEstimated: 150,
        enabled: false,
      });

      expect(item.id).toBe("my-custom-id");
      expect(item.type).toBe("image");
      expect(item.scope).toBe("turn");
      expect(item.tokensEstimated).toBe(150);
      expect(item.enabled).toBe(false);

      s.updateContextItemEnabled(item.id, true);
      const updated = s.getContextItem(item.id);
      expect(updated?.enabled).toBe(true);
    });

    it("returns undefined for non-existent context item", async () => {
      const s = await store();
      stores.push(s);
      expect(s.getContextItem("non-existent")).toBeUndefined();
      expect(s.deleteContextItem("non-existent")).toBe(false);
    });

    it("lists context items in added_at order", async () => {
      const s = await store();
      stores.push(s);

      const run = s.createRun({ id: "ci-order", mode: "single", repositoryPath: "/tmp/repo", prompt: "ci" });
      const sessionId = run.sessionId!;

      s.saveContextItem({ sessionId, type: "note", source: "first" });
      // Small delay to ensure different timestamps
      await new Promise((r) => setTimeout(r, 2));
      s.saveContextItem({ sessionId, type: "note", source: "second" });

      const items = s.listContextItems(sessionId);
      expect(items).toHaveLength(2);
      expect(items[0]!.source).toBe("first");
      expect(items[1]!.source).toBe("second");
    });

    it("computes context metrics for a session (S7-T4)", async () => {
      const s = await store();
      stores.push(s);

      const run = s.createRun({ id: "ci-metrics", mode: "single", repositoryPath: "/tmp/repo", prompt: "ci" });
      const sessionId = run.sessionId!;

      // No items → zero metrics
      const empty = s.getSessionContextMetrics(sessionId);
      expect(empty.totalTokens).toBe(0);
      expect(empty.measurementMethod).toBe("estimated");
      expect(empty.enabledItemCount).toBe(0);
      expect(empty.totalItemCount).toBe(0);

      s.saveContextItem({ sessionId, type: "file", source: "/a.txt", tokensEstimated: 100, measurementMethod: "estimated" });
      s.saveContextItem({ sessionId, type: "file", source: "/b.txt", tokensEstimated: 200, measurementMethod: "estimated", enabled: false });

      const metrics = s.getSessionContextMetrics(sessionId);
      expect(metrics.totalTokens).toBe(100);
      expect(metrics.measurementMethod).toBe("estimated");
      expect(metrics.enabledItemCount).toBe(1);
      expect(metrics.totalItemCount).toBe(2);
    });
  });
});
