import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

// Vite does not recognize node:sqlite as a builtin yet; require keeps it
// external at test time, matching how packages/quota loads it.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
type Database = InstanceType<typeof DatabaseSync>;

/**
 * Durable store for runs, their event streams, and artifact pointers.
 *
 * Run history and the SSE backlog previously lived only in RAM, so a daemon
 * restart erased both. Everything a client can ask for after a restart is
 * written here first.
 *
 * The database lives under the user's Bremio directory, never inside a target
 * repository: a run's records must outlive the repo being cleaned, moved, or
 * deleted, and must never end up committed.
 */

/** Bumped when the schema changes; `migrate` walks from whatever is on disk. */
const SCHEMA_VERSION = 2;

/**
 * Event payloads are telemetry, not archives. A runaway stdout would otherwise
 * grow the database without bound, so oversized payloads are truncated with
 * explicit metadata rather than silently dropped.
 */
export const MAX_PAYLOAD_BYTES = 16 * 1024;

export type RunStatus =
  | "queued"
  | "running"
  /** Cancellation requested; execution has not yet been confirmed stopped. */
  | "cancelling"
  | "completed"
  | "failed"
  | "cancelled"
  /** Cancellation was requested but processes survived it. Needs attention. */
  | "cancellation_failed"
  | "interrupted";

/** Statuses that will never change again without an explicit new action. */
export const TERMINAL_STATUSES: readonly RunStatus[] = [
  "completed",
  "failed",
  "cancelled",
  // Terminal because waiting will not resolve it: something is still running
  // and only the user can decide what to do about it.
  "cancellation_failed",
  "interrupted",
];

export function isTerminal(status: RunStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export interface PersistedRun {
  id: string;
  mode: "single" | "team";
  status: RunStatus;
  repositoryPath: string;
  baseBranch?: string;
  prompt: string;
  startedAt?: string;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
  leadProvider?: string;
  workerProviders?: string[];
  /** The orchestrator's on-disk run id, once it exists. */
  orchestratorRunId?: string;
  finalSummary?: string;
  failureCode?: string;
  failureMessage?: string;
  /** Set when this run was created by retrying another one. */
  retryOfRunId?: string;
  sessionId?: string;
  turnIndex: number;
}

export interface PersistedSession {
  id: string;
  repositoryPath: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  turnCount: number;
  status?: RunStatus;
}

export interface SessionTurn {
  turnIndex: number;
  runId: string;
  prompt: string;
  status: RunStatus;
  model?: string;
  reasoningLevel?: string;
}

export interface SessionDetail {
  id: string;
  repositoryPath: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  turns: SessionTurn[];
}

export interface PersistedRunEvent {
  runId: string;
  seq: number;
  type: string;
  timestamp: string;
  payload: unknown;
}

export interface PersistedArtifact {
  runId: string;
  kind: "report" | "diff" | "worktree" | "log" | "merge";
  path: string;
  taskId?: string;
  createdAt: string;
}

export interface CreateRunInput {
  id: string;
  mode: "single" | "team";
  repositoryPath: string;
  prompt: string;
  leadProvider?: string;
  workerProviders?: string[];
  retryOfRunId?: string;
  sessionId?: string;
}

export function defaultDatabasePath(home = os.homedir()): string {
  return path.join(home, ".bremio", "bremio.db");
}

export class RunStore {
  #closed = false;

  private constructor(private readonly db: Database) {}

  static async open(databasePath = defaultDatabasePath()): Promise<RunStore> {
    await fs.mkdir(path.dirname(databasePath), { recursive: true });
    const db = new DatabaseSync(databasePath);
    // WAL keeps a reader (a replaying client) from blocking the writer.
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    migrate(db);
    return new RunStore(db);
  }

  /**
   * True once closed. A background task racing a shutdown can check this
   * rather than discovering it through an unhandled rejection.
   */
  get closed(): boolean {
    return this.#closed;
  }

  /** Idempotent: shutdown paths can plausibly reach this more than once. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    // Fold the WAL back into the main file so nothing is left mid-write, and
    // so the sidecar files release promptly on Windows.
    try {
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {
      // a checkpoint failure must not stop the close
    }
    this.db.close();
  }

  createRun(input: CreateRunInput): PersistedRun {
    const now = new Date().toISOString();

    // A run created without a session gets one implicitly (single turn), so
    // nothing in the current code path has to change to keep working.
    let sessionId = input.sessionId;
    let turnIndex = 0;
    if (!sessionId) {
      sessionId = crypto.randomUUID();
      this.db
        .prepare(
          "INSERT INTO sessions (id, repository_path, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(sessionId, input.repositoryPath, truncateTitle(input.prompt), now, now);
    } else {
      const last = this.db
        .prepare("SELECT COALESCE(MAX(turn_index), -1) + 1 AS next FROM runs WHERE session_id = ?")
        .get(sessionId) as { next: number };
      turnIndex = Number(last.next);
    }

    this.db
      .prepare(
        `INSERT INTO runs (id, mode, status, repository_path, prompt, created_at, updated_at,
                           lead_provider, worker_providers, retry_of_run_id, session_id, turn_index)
         VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.mode,
        input.repositoryPath,
        input.prompt,
        now,
        now,
        input.leadProvider ?? null,
        input.workerProviders ? JSON.stringify(input.workerProviders) : null,
        input.retryOfRunId ?? null,
        sessionId,
        turnIndex,
      );
    return this.getRun(input.id) as PersistedRun;
  }

  getRun(id: string): PersistedRun | undefined {
    const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? toRun(row) : undefined;
  }

  listRuns(options: { repositoryPath?: string; limit?: number } = {}): PersistedRun[] {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 1000);
    const rows = options.repositoryPath
      ? this.db
          .prepare("SELECT * FROM runs WHERE repository_path = ? ORDER BY created_at DESC LIMIT ?")
          .all(options.repositoryPath, limit)
      : this.db.prepare("SELECT * FROM runs ORDER BY created_at DESC LIMIT ?").all(limit);
    return (rows as Array<Record<string, unknown>>).map(toRun);
  }

  updateRun(
    id: string,
    patch: Partial<
      Pick<
        PersistedRun,
        | "status"
        | "baseBranch"
        | "startedAt"
        | "completedAt"
        | "orchestratorRunId"
        | "finalSummary"
        | "failureCode"
        | "failureMessage"
        | "workerProviders"
      >
    >,
  ): void {
    const columns: Record<string, unknown> = {};
    if (patch.status !== undefined) columns.status = patch.status;
    if (patch.baseBranch !== undefined) columns.base_branch = patch.baseBranch;
    if (patch.startedAt !== undefined) columns.started_at = patch.startedAt;
    if (patch.completedAt !== undefined) columns.completed_at = patch.completedAt;
    if (patch.orchestratorRunId !== undefined) columns.orchestrator_run_id = patch.orchestratorRunId;
    if (patch.finalSummary !== undefined) columns.final_summary = patch.finalSummary;
    if (patch.failureCode !== undefined) columns.failure_code = patch.failureCode;
    if (patch.failureMessage !== undefined) columns.failure_message = patch.failureMessage;
    if (patch.workerProviders !== undefined) {
      columns.worker_providers = JSON.stringify(patch.workerProviders);
    }
    columns.updated_at = new Date().toISOString();

    const assignments = Object.keys(columns).map((column) => `${column} = ?`).join(", ");
    this.db
      .prepare(`UPDATE runs SET ${assignments} WHERE id = ?`)
      .run(...Object.values(columns) as never[], id);
  }

  /**
   * Append an event and return it with its allocated sequence number.
   *
   * The sequence is allocated and the row inserted inside one transaction, so
   * two events arriving back to back cannot receive the same number. The
   * `(run_id, seq)` unique constraint turns any future mistake into a loud
   * failure instead of a silently duplicated stream position.
   */
  appendEvent(runId: string, type: string, payload: unknown): PersistedRunEvent {
    const timestamp = new Date().toISOString();
    const stored = capPayload(redact(payload));

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db
        .prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM run_events WHERE run_id = ?")
        .get(runId) as { next: number };
      const seq = Number(row.next);
      this.db
        .prepare(
          "INSERT INTO run_events (run_id, seq, type, timestamp, payload) VALUES (?, ?, ?, ?, ?)",
        )
        .run(runId, seq, type, timestamp, JSON.stringify(stored));
      this.db.exec("COMMIT");
      return { runId, seq, type, timestamp, payload: stored };
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /**
   * Append an event and change the run's status atomically, so a client can
   * never observe a terminal event over a run still marked running.
   */
  appendEventWithStatus(
    runId: string,
    type: string,
    payload: unknown,
    patch: Parameters<RunStore["updateRun"]>[1],
  ): PersistedRunEvent {
    const timestamp = new Date().toISOString();
    const stored = capPayload(redact(payload));

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db
        .prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM run_events WHERE run_id = ?")
        .get(runId) as { next: number };
      const seq = Number(row.next);
      this.db
        .prepare(
          "INSERT INTO run_events (run_id, seq, type, timestamp, payload) VALUES (?, ?, ?, ?, ?)",
        )
        .run(runId, seq, type, timestamp, JSON.stringify(stored));

      const columns: Record<string, unknown> = { updated_at: timestamp };
      if (patch.status !== undefined) columns.status = patch.status;
      if (patch.completedAt !== undefined) columns.completed_at = patch.completedAt;
      if (patch.startedAt !== undefined) columns.started_at = patch.startedAt;
      if (patch.finalSummary !== undefined) columns.final_summary = patch.finalSummary;
      if (patch.failureCode !== undefined) columns.failure_code = patch.failureCode;
      if (patch.failureMessage !== undefined) columns.failure_message = patch.failureMessage;
      if (patch.orchestratorRunId !== undefined) {
        columns.orchestrator_run_id = patch.orchestratorRunId;
      }
      const assignments = Object.keys(columns).map((column) => `${column} = ?`).join(", ");
      this.db
        .prepare(`UPDATE runs SET ${assignments} WHERE id = ?`)
        .run(...Object.values(columns) as never[], runId);

      this.db.exec("COMMIT");
      return { runId, seq, type, timestamp, payload: stored };
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  readEvents(runId: string, afterSeq = 0, limit = 5000): PersistedRunEvent[] {
    const rows = this.db
      .prepare(
        "SELECT run_id, seq, type, timestamp, payload FROM run_events WHERE run_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?",
      )
      .all(runId, afterSeq, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      runId: String(row.run_id),
      seq: Number(row.seq),
      type: String(row.type),
      timestamp: String(row.timestamp),
      payload: parseJson(row.payload),
    }));
  }

  lastSeq(runId: string): number {
    const row = this.db
      .prepare("SELECT COALESCE(MAX(seq), 0) AS last FROM run_events WHERE run_id = ?")
      .get(runId) as { last: number };
    return Number(row.last);
  }

  recordArtifact(artifact: Omit<PersistedArtifact, "createdAt">): void {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO artifacts (run_id, kind, path, task_id, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        artifact.runId,
        artifact.kind,
        artifact.path,
        artifact.taskId ?? null,
        new Date().toISOString(),
      );
  }

  listArtifacts(runId: string): PersistedArtifact[] {
    const rows = this.db
      .prepare("SELECT * FROM artifacts WHERE run_id = ? ORDER BY created_at ASC")
      .all(runId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      runId: String(row.run_id),
      kind: String(row.kind) as PersistedArtifact["kind"],
      path: String(row.path),
      ...(row.task_id ? { taskId: String(row.task_id) } : {}),
      createdAt: String(row.created_at),
    }));
  }

  /** Runs that were mid-flight when the process died. */
  nonTerminalRuns(): PersistedRun[] {
    const rows = this.db
      .prepare(
        // `cancelling` counts too: a daemon that died mid-cancellation left the
        // run in a state only a restart can resolve.
        "SELECT * FROM runs WHERE status IN ('queued', 'running', 'cancelling') ORDER BY created_at ASC",
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map(toRun);
  }

  /**
   * Delete terminal runs older than the cutoff, keeping at least `keepMinimum`.
   * Active and interrupted runs are never removed: interrupted still needs a
   * decision from the user, so discarding it would destroy the evidence.
   *
   * Sessions are kept whole to preserve conversation continuity — pruning a run
   * from the middle of a session would leave the transcript with a hole. Either
   * every terminal run in the session is older than the cutoff and none of the
   * session's runs are in the keep-minimum set, or the session stays untouched.
   */
  pruneRuns(options: { olderThan: Date; keepMinimum?: number }): number {
    const keep = options.keepMinimum ?? 20;
    const cutoff = options.olderThan.toISOString();

    const rows = this.db
      .prepare(
        `SELECT s.id FROM sessions s
         WHERE NOT EXISTS (
           SELECT 1 FROM runs r
           WHERE r.session_id = s.id
             AND (r.status NOT IN ('completed', 'failed', 'cancelled')
               OR r.created_at >= ?)
         )
         AND EXISTS (
           SELECT 1 FROM runs r
           WHERE r.session_id = s.id
         )
         AND s.id NOT IN (
           SELECT r.session_id FROM runs r
           WHERE r.status IN ('completed', 'failed', 'cancelled')
           GROUP BY r.session_id
           ORDER BY MAX(r.created_at) DESC
           LIMIT ?
         )`,
      )
      .all(cutoff, keep) as Array<{ id: string }>;

    if (rows.length === 0) return 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const del = this.db.prepare("DELETE FROM sessions WHERE id = ?");
      for (const row of rows) del.run(row.id);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return rows.length;
  }

  listSessions(repositoryPath: string): PersistedSession[] {
    const rows = this.db
      .prepare(
        `SELECT s.*, COUNT(r.id) AS turn_count,
                (SELECT status FROM runs WHERE session_id = s.id ORDER BY turn_index DESC LIMIT 1) AS status
         FROM sessions s
         LEFT JOIN runs r ON r.session_id = s.id
         WHERE s.repository_path = ?
         GROUP BY s.id
         ORDER BY MAX(r.created_at) DESC, s.created_at DESC`,
      )
      .all(repositoryPath) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      repositoryPath: String(row.repository_path),
      title: String(row.title),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      turnCount: Number(row.turn_count),
      ...(row.status ? { status: String(row.status) as RunStatus } : {}),
    }));
  }

  sessionDetail(id: string): SessionDetail | undefined {
    const session = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    if (!session) return undefined;

    const runs = this.db
      .prepare("SELECT * FROM runs WHERE session_id = ? ORDER BY turn_index ASC")
      .all(id) as Array<Record<string, unknown>>;

    const turns: SessionTurn[] = runs.map((row) => {
      const run = toRun(row);
      // Extract the last usage event for provider-confirmed model/reasoning.
      const events = this.readEvents(run.id);
      const usagePayload = [...events]
        .reverse()
        .find((e) => e.type === "usage")?.payload as
        | { model?: string; reasoningLevel?: string }
        | undefined;
      return {
        turnIndex: run.turnIndex,
        runId: run.id,
        prompt: run.prompt,
        status: run.status,
        ...(usagePayload?.model ? { model: usagePayload.model } : {}),
        ...(usagePayload?.reasoningLevel ? { reasoningLevel: usagePayload.reasoningLevel } : {}),
      };
    });

    return {
      id: String(session.id),
      repositoryPath: String(session.repository_path),
      title: String(session.title),
      createdAt: String(session.created_at),
      updatedAt: String(session.updated_at),
      turns,
    };
  }
}

export function truncateTitle(prompt: string, maxLen = 80): string {
  const firstLine = prompt.split("\n")[0] ?? prompt;
  if (firstLine.length <= maxLen) return firstLine;
  return firstLine.slice(0, maxLen - 3) + "...";
}

function migrate(db: Database): void {
  const { user_version: current } = db.prepare("PRAGMA user_version").get() as {
    user_version: number;
  };
  if (Number(current) >= SCHEMA_VERSION) return;

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
  `);

  if (Number(current) < 2) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        repository_path TEXT NOT NULL,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    db.exec("ALTER TABLE runs ADD COLUMN session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE");
    db.exec("ALTER TABLE runs ADD COLUMN turn_index INTEGER NOT NULL DEFAULT 0");

    // Backfill: each existing run becomes its own single-turn session so no
    // data is lost and the history is immediately navigable.
    const existing = db
      .prepare("SELECT id, repository_path, prompt, created_at FROM runs")
      .all() as Array<{ id: string; repository_path: string; prompt: string; created_at: string }>;
    for (const run of existing) {
      const sessionId = `ses-${run.id}`;
      const title = truncateTitle(run.prompt);
      db.prepare(
        "INSERT OR IGNORE INTO sessions (id, repository_path, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      ).run(sessionId, run.repository_path, title, run.created_at, run.created_at);
      db.prepare("UPDATE runs SET session_id = ?, turn_index = 0 WHERE id = ?").run(
        sessionId,
        run.id,
      );
    }
  }

  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}

function toRun(row: Record<string, unknown>): PersistedRun {
  return {
    id: String(row.id),
    mode: row.mode === "team" ? "team" : "single",
    status: String(row.status) as RunStatus,
    repositoryPath: String(row.repository_path),
    prompt: String(row.prompt),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    turnIndex: Number(row.turn_index ?? 0),
    ...(row.base_branch ? { baseBranch: String(row.base_branch) } : {}),
    ...(row.started_at ? { startedAt: String(row.started_at) } : {}),
    ...(row.completed_at ? { completedAt: String(row.completed_at) } : {}),
    ...(row.lead_provider ? { leadProvider: String(row.lead_provider) } : {}),
    ...(row.worker_providers
      ? { workerProviders: parseJson(row.worker_providers) as string[] }
      : {}),
    ...(row.orchestrator_run_id ? { orchestratorRunId: String(row.orchestrator_run_id) } : {}),
    ...(row.final_summary ? { finalSummary: String(row.final_summary) } : {}),
    ...(row.failure_code ? { failureCode: String(row.failure_code) } : {}),
    ...(row.failure_message ? { failureMessage: String(row.failure_message) } : {}),
    ...(row.retry_of_run_id ? { retryOfRunId: String(row.retry_of_run_id) } : {}),
    ...(row.session_id ? { sessionId: String(row.session_id) } : {}),
  };
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

const SECRET_KEY = /token|secret|password|credential|api[-_]?key|authorization|bearer/i;

/**
 * Strip anything that looks like a credential before it reaches disk. Event
 * payloads carry provider output and orchestration metadata, and a persisted
 * log is exactly where a leaked token would sit unnoticed.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 8 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET_KEY.test(key) ? "[redacted]" : redact(item, depth + 1);
  }
  return out;
}

/** Truncate an oversized payload, saying so explicitly rather than dropping it. */
export function capPayload(value: unknown, maxBytes = MAX_PAYLOAD_BYTES): unknown {
  const encoded = JSON.stringify(value ?? null);
  if (encoded.length <= maxBytes) return value;
  return {
    truncated: true,
    originalBytes: encoded.length,
    preview: encoded.slice(0, maxBytes),
  };
}
