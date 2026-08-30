import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { statSync } from "node:fs";
import { createRequire } from "node:module";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { MemoryEntry, MemoryQuery, MemoryScope } from "@bremio/memory";

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
const SCHEMA_VERSION = 17;

/**
 * One repository can be named several ways by the OS that launched us: Windows
 * hands back `d:\repo` or `D:\repo` depending on how the shell was entered, and
 * either separator resolves the same directory. Comparing the raw strings made
 * a session list come back empty for the very repository it was run in, which
 * looks exactly like history loss.
 *
 * Matching is therefore done on a canonical form. It is applied at read time
 * rather than by rewriting stored rows, so history written by older versions
 * keeps matching without a migration touching data we cannot re-derive.
 */
export function normalizeRepositoryPath(repositoryPath: string): string {
  // Only A-Z is folded: SQLite's LOWER() is ASCII-only, and JavaScript's
  // toLowerCase() is not. On a path containing non-ASCII letters the two would
  // disagree and the lookup would silently miss again.
  return repositoryPath
    .replaceAll("\\", "/")
    .replace(/[A-Z]/g, (ch) => ch.toLowerCase())
    .replace(/\/+$/, "");
}

/**
 * Resolve the canonical identity of the repository at `repositoryPath`.
 *
 * Derives the identity from `git rev-parse --git-common-dir` when the path is
 * inside a git repository, which is stable across worktrees, symlinks, and
 * path variants. For non-git directories, `repositoryId` falls back to the
 * normalised path itself.
 */
export function resolveRepositoryIdentity(repositoryPath: string): RepositoryIdentity {
  const canonicalRoot = normalizeRepositoryPath(path.resolve(repositoryPath));

  try {
    const stdout = execSync("git rev-parse --git-common-dir", {
      cwd: repositoryPath,
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();

    const gitCommonDir = stdout ? normalizeRepositoryPath(path.resolve(repositoryPath, stdout)) : undefined;

    if (!gitCommonDir) {
      return { repositoryId: canonicalRoot, canonicalRoot };
    }

    let worktreeId: string | undefined;

    // Check if this is a linked worktree by examining .git.
    const gitLinkPath = path.join(repositoryPath, ".git");
    let isWorktree = false;
    try {
      const st = statSync(gitLinkPath);
      // If .git is a file (contains "gitdir: ..."), this is a linked worktree.
      isWorktree = st.isFile();
    } catch {
      // statSync throws if .git doesn't exist; treat as non-worktree.
    }

    if (isWorktree) {
      // The worktree id is the canonical root itself (the worktree dir).
      worktreeId = canonicalRoot;
    }

    const repositoryId = gitCommonDir;

    return { repositoryId, canonicalRoot, gitCommonDir, ...(worktreeId ? { worktreeId } : {}) };
  } catch {
    // Not a git repository or git is unavailable; fall back to canonical path.
    return { repositoryId: canonicalRoot, canonicalRoot };
  }
}

/**
 * The SQL half of {@link normalizeRepositoryPath}. The two must agree, which
 * `storage.test.ts` pins by querying with a differently-cased path.
 */
const SAME_REPO_PATH = "RTRIM(LOWER(REPLACE(repository_path, '\\', '/')), '/') = ?";

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
  | "interrupted"
  /** Daemon restarted while a run was executing; the child may still be alive. */
  | "supervision_lost"
  /** Agent finished in an isolated worktree; waiting for user approval before applying changes. */
  | "pending_approval";

/** Statuses that will never change again without an explicit new action. */
export const TERMINAL_STATUSES: readonly RunStatus[] = [
  "completed",
  "failed",
  "cancelled",
  // Terminal because waiting will not resolve it: something is still running
  // and only the user can decide what to do about it.
  "cancellation_failed",
  "interrupted",
  "supervision_lost",
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
  repositoryId?: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  turnCount: number;
  status?: RunStatus;
  parentSessionId?: string;
  forkedFromTurn?: number;
}

export interface ProjectSessionGroup {
  repositoryId: string;
  repositoryPath: string;
  projectName: string;
  sessions: PersistedSession[];
}

export interface SessionTurn {
  turnIndex: number;
  runId: string;
  prompt: string;
  status: RunStatus;
  /**
   * Provider-*confirmed* model, scraped from the turn's last `usage` event.
   *
   * This is a runtime fact, not the user's intent. It must never be used to
   * work out which agent to run — see `leadProvider` below.
   */
  model?: string;
  reasoningLevel?: string;
  /**
   * The agent this turn actually ran on, as recorded when the run was created.
   *
   * `runs.lead_provider` has been stored since the first schema; it simply was
   * not projected here, so resume had nothing authoritative to read and fell
   * back to parsing `model`. That parse could not work: `model` comes from
   * `usage` events, and providers here emit none.
   */
  leadProvider?: string;
  workerProviders?: string[];
  /** `single` | `team` as persisted. The session's collaboration mode. */
  mode?: PersistedRun["mode"];
}

export type BlackboardEntryKind = "fact" | "decision" | "blocker" | "question" | "artifact";

export interface BlackboardEntry {
  id: string;
  runId: string;
  kind: BlackboardEntryKind;
  content: string;
  author: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface SessionDetail {
  id: string;
  repositoryPath: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  turns: SessionTurn[];
  config?: SessionConfig;
  repositoryIdentity?: RepositoryIdentity;
  parentSessionId?: string;
  forkedFromTurn?: number;
}

export interface PersistedRunEvent {
  runId: string;
  seq: number;
  type: string;
  timestamp: string;
  payload: unknown;
}

export type RecordProvenance = "native" | "legacy-derived" | "legacy-import";

export interface SessionConfig {
  sessionId: string;
  revision: number;
  mode?: "single" | "team";
  leadAgentId?: string;
  workerAgentId?: string;
  model?: string;
  reasoningLevel?: string;
  permission?: string;
  approvalMode?: string;
  cwd?: string;
  baseBranch?: string;
  provenance: RecordProvenance;
  completeness: "complete" | "partial";
  missingFields: string[];
  createdAt: string;
  changedBy?: string;
  changeReason?: string;
  collaborationState?: string;
}

export interface CreateSessionConfigInput {
  sessionId: string;
  mode?: "single" | "team";
  leadAgentId?: string;
  workerAgentId?: string;
  model?: string;
  reasoningLevel?: string;
  permission?: string;
  approvalMode?: string;
  cwd?: string;
  baseBranch?: string;
  provenance?: RecordProvenance;
  changedBy?: string;
  changeReason?: string;
  collaborationState?: string;
}

export interface PersistedSessionCompact {
  id: string;
  sessionId: string;
  turnRangeStart: number;
  turnRangeEnd: number;
  summary: string;
  tokenCount: number;
  measurementMethod: "estimated" | "measured";
  compactedRunIds: string[];
  createdAt: string;
  createdBy: string;
}

export interface PersistedSessionContext {
  sessionId: string;
  turnIndex: number;
  summary?: string;
  providerSessionIds?: Record<string, string>;
  createdAt: string;
}

export interface SaveSessionContextInput {
  sessionId: string;
  turnIndex: number;
  summary?: string;
  providerSessionIds?: Record<string, string>;
}

export type ContextItemType = "file" | "folder" | "selection" | "image" | "url" | "terminal" | "diff" | "note";
export type ContextItemScope = "message" | "turn" | "session";

export interface PersistedContextItem {
  id: string;
  sessionId: string;
  type: ContextItemType;
  source: string;
  addedAt: string;
  scope: ContextItemScope;
  tokensEstimated?: number;
  measurementMethod?: "estimated" | "measured";
  enabled: boolean;
}

export interface CreateContextItemInput {
  id?: string;
  sessionId: string;
  type: ContextItemType;
  source: string;
  scope?: ContextItemScope;
  tokensEstimated?: number;
  measurementMethod?: "estimated" | "measured";
  enabled?: boolean;
}

/**
 * Canonical identity for a repository, designed to survive symlinks, git
 * worktrees, and cross-platform path variance (Windows vs WSL).
 *
 * - `repositoryId` is stable for the same logical repo across worktrees.
 * - `canonicalRoot` is the input path after normalisation.
 * - `gitCommonDir` is the output of `git rev-parse --git-common-dir` when the
 *   path is inside a git repository, normalised and resolved to an absolute
 *   path. It is *not* set for bare repos or non-git directories.
 * - `worktreeId` distinguishes worktree directories under the same repo (the
 *   *linked* worktree path, not the main worktree).
 */
export interface RepositoryIdentity {
  repositoryId: string;
  canonicalRoot: string;
  gitCommonDir?: string;
  worktreeId?: string;
}

export interface ProviderSessionBinding {
  bremioSessionId: string;
  agentId: string;
  transport: string;
  nativeSessionId?: string;
  status: "active" | "lost" | "expired";
  turnIndex: number;
  createdAt: string;
  lastUsedAt: string;
}

export interface SetBindingStatusInput {
  bremioSessionId: string;
  agentId: string;
  status: "active" | "lost" | "expired";
  nativeSessionId?: string;
}

export interface PersistedArtifact {
  runId: string;
  kind: string;
  path: string;
  taskId?: string;
  createdAt: string;
}

export interface PersistedApprovalRequest {
  id: string;
  sessionId: string;
  runId: string;
  actionClass: string;
  actionTarget: string;
  actionDescription: string;
  actionDigest: string;
  risk: string;
  state: string;
  requestedAt: string;
  decidedAt?: string;
  decidedBy?: string;
  reason?: string;
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
      const identity = resolveRepositoryIdentity(input.repositoryPath);
      this.db
        .prepare(
          "INSERT INTO sessions (id, repository_path, repository_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(sessionId, input.repositoryPath, identity.repositoryId, truncateTitle(input.prompt), now, now);
      this.createSessionConfig({
        sessionId,
        mode: input.mode,
        leadAgentId: input.leadProvider,
        ...(input.workerProviders?.length ? { workerAgentId: input.workerProviders[0] } : {}),
        provenance: "native",
      });
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

    // Record provider session bindings for the lead agent and each worker agent.
    if (input.leadProvider) {
      this.recordBinding(sessionId, input.leadProvider, input.leadProvider, turnIndex);
    }
    for (const w of input.workerProviders ?? []) {
      this.recordBinding(sessionId, w, w, turnIndex);
    }

    return this.getRun(input.id) as PersistedRun;
  }

  /**
   * Import a single report from disk into the store.
   *
   * Creates a session + run with `provenance: "legacy-import"` and preserves
   * the original timestamp. Idempotent: if a run with the same
   * `orchestrator_run_id` already exists, skips it and returns the existing one.
   */
  importReport(reportRunId: string, report: Record<string, unknown>, repoPath: string): { sessionId: string; runId: string; skipped: boolean } {
    // Idempotency: check if this orchestrator run id was already imported.
    const existing = this.db
      .prepare("SELECT id, session_id FROM runs WHERE orchestrator_run_id = ?")
      .get(reportRunId) as { id: string; session_id: string } | undefined;
    if (existing) return { sessionId: existing.session_id, runId: existing.id, skipped: true };

    const now = new Date().toISOString();
    const createdAt = typeof report.createdAt === "string" ? report.createdAt : now;
    const mode = report.mode === "single" ? "single" : "team";
    const prompt = typeof report.prompt === "string" ? report.prompt : "";

    const sessionId = crypto.randomUUID();
    const identity = resolveRepositoryIdentity(repoPath);
    this.db
      .prepare(
        "INSERT INTO sessions (id, repository_path, repository_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(sessionId, repoPath, identity.repositoryId, truncateTitle(prompt), createdAt, createdAt);

    this.createSessionConfig({
      sessionId,
      mode,
      leadAgentId: mode === "single"
        ? (report.primaryAgentId as string | undefined)
        : (report.leadAgentId as string | undefined),
      provenance: "legacy-import",
    });

    const runId = `run-${Date.now().toString(36)}-${String(performance.now()).replace(".", "")}`;
    const status = deriveReportStatus(report);
    const leadProvider = mode === "single"
      ? (report.primaryAgentId as string | undefined)
      : (report.leadAgentId as string | undefined);

    this.db
      .prepare(
        `INSERT INTO runs (id, mode, status, repository_path, prompt, created_at, updated_at,
                           lead_provider, session_id, turn_index, orchestrator_run_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      )
      .run(
        runId,
        mode,
        status,
        repoPath,
        prompt,
        createdAt,
        now,
        leadProvider ?? null,
        sessionId,
        reportRunId,
      );

    // Create a terminal event so the TUI has something to display.
    const summary = mode === "single"
      ? (report.result as Record<string, unknown> | undefined)?.summary
      : (report.plan as Record<string, unknown> | undefined)?.summary;
    const eventKind = status === "completed" ? "finished" : status === "failed" ? "failed" : "interrupted";
    this.appendEventWithStatus(
      runId,
      eventKind,
      { message: typeof summary === "string" ? summary : `imported legacy run (${reportRunId})` },
      { status, completedAt: createdAt, orchestratorRunId: reportRunId },
    );

    return { sessionId, runId, skipped: false };
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
          .prepare(
            `SELECT * FROM runs WHERE ${SAME_REPO_PATH} ORDER BY created_at DESC LIMIT ?`,
          )
          .all(normalizeRepositoryPath(options.repositoryPath), limit)
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

  getLastGuardDecision(runId: string, agentId: string): any {
    const row = this.db
      .prepare(
        "SELECT payload FROM events WHERE run_id = ? AND type = 'task-event' AND json_extract(payload, '$.data.type') = 'guard_decision' ORDER BY seq DESC LIMIT 1"
      )
      .get(runId) as { payload: string } | undefined;
    
    if (!row) return undefined;
    try {
      const parsed = JSON.parse(row.payload);
      // guard_decision data includes decision in the payload, but let's check
      // we emit `{ type: "guard_decision", runId, ts, decision: {...} }`
      if (parsed.agentId === agentId && parsed.data?.decision) {
        return parsed.data.decision;
      }
      // Wait, events table payload is the `data` of the emitted event.
      // So payload contains `agentId` inside it?
      // Actually `processGuard` does `this.#emit(runId, { kind: "task-event", agentId, data: { type: "guard_decision", decision } })`.
      // `runs.ts`'s `this.#emit` appends to `events` table?
      // Let's just do a json_extract in sqlite to match agentId, or just parse and check.
    } catch {
      return undefined;
    }
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

  /**
   * The run currently occupying a session, if any.
   *
   * `cancelling` counts as occupied: the process tree is still being torn down,
   * and starting the next turn on top of it would have two agents in one
   * workspace.
   */
  activeRunForSession(sessionId: string): PersistedRun | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM runs WHERE session_id = ? AND status IN ('running', 'cancelling', 'pending_approval')
         ORDER BY turn_index DESC LIMIT 1`,
      )
      .get(sessionId) as Record<string, unknown> | undefined;
    return row ? toRun(row) : undefined;
  }

  /** Prompts waiting behind the active turn, oldest first. */
  queuedRunsForSession(sessionId: string): PersistedRun[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM runs WHERE session_id = ? AND status = 'queued' ORDER BY turn_index ASC",
      )
      .all(sessionId) as Array<Record<string, unknown>>;
    return rows.map(toRun);
  }

  /**
   * Drop a run that has not started.
   *
   * Refuses anything past `queued`: a run that executed owns history — events,
   * artifacts, a report — and deleting it would leave the session's transcript
   * with a hole, which is the same reason `pruneRuns` keeps sessions whole.
   */
  deleteQueuedRun(id: string): boolean {
    const result = this.db
      .prepare("DELETE FROM runs WHERE id = ? AND status = 'queued'")
      .run(id);
    return Number(result.changes) > 0;
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

  listSessions(repositoryPath?: string): PersistedSession[] {
    const whereClause = repositoryPath
      ? `WHERE ${SAME_REPO_PATH.replace("repository_path", "s.repository_path")}`
      : "";
    const params = repositoryPath ? [normalizeRepositoryPath(repositoryPath)] : [];
    const rows = this.db
      .prepare(
        `SELECT s.*, COUNT(r.id) AS turn_count,
                (SELECT status FROM runs WHERE session_id = s.id ORDER BY turn_index DESC LIMIT 1) AS status
         FROM sessions s
         LEFT JOIN runs r ON r.session_id = s.id
         ${whereClause}
         GROUP BY s.id
         ORDER BY MAX(r.created_at) DESC, s.created_at DESC`,
      )
      .all(...params) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      repositoryPath: String(row.repository_path),
      repositoryId: row.repository_id ? String(row.repository_id) : undefined,
      title: String(row.title),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      turnCount: Number(row.turn_count),
      ...(row.status ? { status: String(row.status) as RunStatus } : {}),
      ...(row.parent_session_id ? { parentSessionId: String(row.parent_session_id) } : {}),
      ...(row.forked_from_turn !== null && row.forked_from_turn !== undefined
        ? { forkedFromTurn: Number(row.forked_from_turn) }
        : {}),
    }));
  }

  /**
   * Cross-repository sessions grouped by canonical repository identity (S10-T8).
   *
   * Keyed by the canonical repository identity from `resolveRepositoryIdentity`
   * (so a worktree and its main checkout group together).
   */
  listGroupedSessions(): ProjectSessionGroup[] {
    const all = this.listSessions();
    const groupsMap = new Map<string, ProjectSessionGroup>();

    for (const session of all) {
      const repoId = session.repositoryId || normalizeRepositoryPath(session.repositoryPath);
      let group = groupsMap.get(repoId);
      if (!group) {
        const repoPath = session.repositoryPath;
        const normalized = repoPath.replace(/\\/g, "/").replace(/\/$/, "");
        const projectName = normalized.split("/").pop() || "project";
        group = {
          repositoryId: repoId,
          repositoryPath: repoPath,
          projectName,
          sessions: [],
        };
        groupsMap.set(repoId, group);
      }
      group.sessions.push(session);
    }

    return Array.from(groupsMap.values());
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
        ...(run.leadProvider ? { leadProvider: run.leadProvider } : {}),
        ...(run.workerProviders ? { workerProviders: run.workerProviders } : {}),
        mode: run.mode,
      };
    });

    const cfg = this.getSessionConfig(id);

    // Build repository identity from session columns.
    const repositoryIdentity: RepositoryIdentity | undefined = session.repository_id
      ? {
          repositoryId: String(session.repository_id),
          canonicalRoot: String(session.repository_path),
        }
      : undefined;

    return {
      id: String(session.id),
      repositoryPath: String(session.repository_path),
      title: String(session.title),
      createdAt: String(session.created_at),
      updatedAt: String(session.updated_at),
      turns,
      ...(cfg ? { config: cfg } : {}),
      ...(repositoryIdentity ? { repositoryIdentity } : {}),
      ...(session.parent_session_id ? { parentSessionId: String(session.parent_session_id) } : {}),
      ...(session.forked_from_turn !== null && session.forked_from_turn !== undefined
        ? { forkedFromTurn: Number(session.forked_from_turn) }
        : {}),
    };
  }

  /**
   * Fork a new session from a specific turn of an existing session (S10-T14).
   *
   * Lineage: records parent_session_id and forked_from_turn in the sessions table.
   * History: copies turns 0...forkedFromTurn into the new session with fresh run IDs,
   * preserving prompt, mode, lead_provider, worker_providers, status, turn_index, events, and artifacts.
   * Config: copies all session config revisions from the parent session.
   * Fresh binding: starts with NO provider session bindings (docs/15 §4.3.1) to prevent
   * crosstalk and contaminated provider-side conversation state.
   */
  forkSession(sessionId: string, forkedFromTurn: number): SessionDetail {
    const parent = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId) as
      | Record<string, unknown>
      | undefined;
    if (!parent) {
      throw new Error(`parent session not found: ${sessionId}`);
    }

    const runs = this.db
      .prepare("SELECT * FROM runs WHERE session_id = ? ORDER BY turn_index ASC")
      .all(sessionId) as Array<Record<string, unknown>>;

    if (runs.length === 0) {
      throw new Error(`cannot fork session ${sessionId}: it has no turns`);
    }

    if (forkedFromTurn < 0 || forkedFromTurn >= runs.length) {
      throw new Error(
        `invalid turn index ${forkedFromTurn}: session ${sessionId} has ${runs.length} turn(s) (indices 0..${runs.length - 1})`,
      );
    }

    const forkedSessionId = crypto.randomUUID();
    const now = new Date().toISOString();
    const title = `Fork of ${parent.title} (turn ${forkedFromTurn})`;

    this.db
      .prepare(
        `INSERT INTO sessions
           (id, repository_path, repository_id, title, created_at, updated_at, parent_session_id, forked_from_turn)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        forkedSessionId,
        String(parent.repository_path),
        parent.repository_id ? String(parent.repository_id) : null,
        title,
        now,
        now,
        sessionId,
        forkedFromTurn,
      );

    // Copy session config revisions
    const configs = this.db
      .prepare("SELECT * FROM session_config WHERE session_id = ? ORDER BY revision ASC")
      .all(sessionId) as Array<Record<string, unknown>>;

    for (const cfg of configs) {
      this.db
        .prepare(
          `INSERT INTO session_config
             (session_id, revision, mode, lead_agent_id, worker_agent_id, model, reasoning_level,
              permission, approval_mode, cwd, base_branch, provenance, completeness, missing_fields,
              changed_by, change_reason, collaboration_state, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          forkedSessionId,
          Number(cfg.revision),
          cfg.mode ? String(cfg.mode) : null,
          cfg.lead_agent_id ? String(cfg.lead_agent_id) : null,
          cfg.worker_agent_id ? String(cfg.worker_agent_id) : null,
          cfg.model ? String(cfg.model) : null,
          cfg.reasoning_level ? String(cfg.reasoning_level) : null,
          cfg.permission ? String(cfg.permission) : null,
          cfg.approval_mode ? String(cfg.approval_mode) : null,
          cfg.cwd ? String(cfg.cwd) : null,
          cfg.base_branch ? String(cfg.base_branch) : null,
          cfg.provenance ? String(cfg.provenance) : "native",
          cfg.completeness ? String(cfg.completeness) : "complete",
          cfg.missing_fields ? String(cfg.missing_fields) : "[]",
          "fork",
          `Forked from session ${sessionId} at turn ${forkedFromTurn}`,
          cfg.collaboration_state ? String(cfg.collaboration_state) : null,
          now,
        );
    }

    // Copy turns 0...forkedFromTurn with fresh run IDs
    const truncatedRuns = runs.slice(0, forkedFromTurn + 1);
    for (const r of truncatedRuns) {
      const originalRunId = String(r.id);
      const freshRunId = `run-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 6)}`;

      this.db
        .prepare(
          `INSERT INTO runs (id, mode, status, repository_path, prompt, base_branch, started_at, completed_at,
                             created_at, updated_at, lead_provider, worker_providers, orchestrator_run_id,
                             final_summary, failure_code, failure_message, retry_of_run_id, session_id, turn_index)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          freshRunId,
          String(r.mode),
          String(r.status),
          String(r.repository_path),
          String(r.prompt),
          r.base_branch ? String(r.base_branch) : null,
          r.started_at ? String(r.started_at) : null,
          r.completed_at ? String(r.completed_at) : null,
          String(r.created_at),
          String(r.updated_at),
          r.lead_provider ? String(r.lead_provider) : null,
          r.worker_providers ? String(r.worker_providers) : null,
          r.orchestrator_run_id ? String(r.orchestrator_run_id) : null,
          r.final_summary ? String(r.final_summary) : null,
          r.failure_code ? String(r.failure_code) : null,
          r.failure_message ? String(r.failure_message) : null,
          r.retry_of_run_id ? String(r.retry_of_run_id) : null,
          forkedSessionId,
          Number(r.turn_index),
        );

      // Copy run_events for the turn
      const events = this.db
        .prepare("SELECT * FROM run_events WHERE run_id = ? ORDER BY seq ASC")
        .all(originalRunId) as Array<Record<string, unknown>>;
      for (const ev of events) {
        this.db
          .prepare(
            "INSERT INTO run_events (run_id, seq, type, timestamp, payload) VALUES (?, ?, ?, ?, ?)",
          )
          .run(freshRunId, Number(ev.seq), String(ev.type), String(ev.timestamp), String(ev.payload));
      }

      // Copy artifacts
      const artifacts = this.db
        .prepare("SELECT * FROM artifacts WHERE run_id = ?")
        .all(originalRunId) as Array<Record<string, unknown>>;
      for (const a of artifacts) {
        this.db
          .prepare(
            "INSERT INTO artifacts (run_id, kind, path, task_id, created_at) VALUES (?, ?, ?, ?, ?)",
          )
          .run(freshRunId, String(a.kind), String(a.path), a.task_id ? String(a.task_id) : null, String(a.created_at));
      }

      // Copy blackboard entries
      const blackboard = this.db
        .prepare("SELECT * FROM run_blackboard WHERE run_id = ?")
        .all(originalRunId) as Array<Record<string, unknown>>;
      for (const b of blackboard) {
        this.db
          .prepare(
            "INSERT INTO run_blackboard (id, run_id, type, content, author, created_at, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            randomUUID(),
            freshRunId,
            String(b.type),
            String(b.content),
            String(b.author),
            String(b.created_at),
            String(b.metadata),
          );
      }
    }

    // Copy context items (session-scoped items)
    const ctxItems = this.db
      .prepare("SELECT * FROM context_items WHERE session_id = ?")
      .all(sessionId) as Array<Record<string, unknown>>;
    for (const item of ctxItems) {
      const freshItemId = crypto.randomUUID();
      this.db
        .prepare(
          `INSERT INTO context_items (id, session_id, type, source, added_at, scope, tokens_estimated, enabled, measurement_method)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          freshItemId,
          forkedSessionId,
          String(item.type),
          String(item.source),
          now,
          item.scope ? String(item.scope) : "session",
          item.tokens_estimated !== null && item.tokens_estimated !== undefined ? Number(item.tokens_estimated) : null,
          item.enabled !== null && item.enabled !== undefined ? Number(item.enabled) : 1,
          item.measurement_method ? String(item.measurement_method) : "estimated",
        );
    }

    // Note: ProviderSessionBinding is NOT copied. The forked session starts fresh (docs/15 §4.3.1).

    return this.sessionDetail(forkedSessionId)!;
  }

  saveSessionContext(input: SaveSessionContextInput): PersistedSessionContext {
    const now = new Date().toISOString();
    const providerJson =
      input.providerSessionIds && Object.keys(input.providerSessionIds).length > 0
        ? JSON.stringify(input.providerSessionIds)
        : null;
    const summaryVal = input.summary !== undefined ? input.summary : null;

    this.db
      .prepare(
        `INSERT INTO session_context (session_id, turn_index, summary, provider_session_ids, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(session_id, turn_index) DO UPDATE SET
           summary = excluded.summary,
           provider_session_ids = excluded.provider_session_ids,
           created_at = excluded.created_at`,
      )
      .run(input.sessionId, input.turnIndex, summaryVal, providerJson, now);

    return this.getSessionContext(input.sessionId, input.turnIndex)!;
  }

  getSessionContext(sessionId: string, turnIndex: number): PersistedSessionContext | undefined {
    const row = this.db
      .prepare("SELECT * FROM session_context WHERE session_id = ? AND turn_index = ?")
      .get(sessionId, turnIndex) as Record<string, unknown> | undefined;
    return row ? toSessionContext(row) : undefined;
  }

  listSessionContexts(sessionId: string): PersistedSessionContext[] {
    const rows = this.db
      .prepare("SELECT * FROM session_context WHERE session_id = ? ORDER BY turn_index ASC")
      .all(sessionId) as Array<Record<string, unknown>>;
    return rows.map(toSessionContext);
  }

  getLatestSessionContext(sessionId: string): PersistedSessionContext | undefined {
    const row = this.db
      .prepare("SELECT * FROM session_context WHERE session_id = ? ORDER BY turn_index DESC LIMIT 1")
      .get(sessionId) as Record<string, unknown> | undefined;
    return row ? toSessionContext(row) : undefined;
  }

  /**
   * Fold every turn before the latest into one summary row.
   *
   * `createdBy` records who asked. It was hard-coded to `'manual'`, so an
   * automatic compact appeared in `bremio session compacts` as the user's own
   * doing — the audit trail naming the wrong actor for the thing that shrank
   * their context.
   */
  compactSession(
    sessionId: string,
    createdBy: "manual" | "auto" = "manual",
  ): PersistedSessionCompact {
    const runs = this.db
      .prepare("SELECT * FROM runs WHERE session_id = ? ORDER BY turn_index ASC")
      .all(sessionId) as Array<Record<string, unknown>>;

    if (runs.length === 0) throw new Error(`session ${sessionId} has no runs to compact`);

    const latestTurnIndex = runs.reduce((max, r) => Math.max(max, Number(r.turn_index ?? 0)), 0);

    // Compact all turns before the latest one
    const compactRuns = runs.filter((r) => Number(r.turn_index ?? 0) < latestTurnIndex);

    if (compactRuns.length === 0) throw new Error(`session ${sessionId} has only the current turn; nothing to compact`);

    const turnRangeStart = Number(compactRuns[0]!.turn_index ?? 0);
    const turnRangeEnd = Number(compactRuns[compactRuns.length - 1]!.turn_index ?? 0);
    const compactedRunIds: string[] = [];
    const summaryParts: string[] = [];
    let totalTokens = 0;

    for (const run of compactRuns) {
      const runId = String(run.id);
      compactedRunIds.push(runId);
      const prompt = String(run.prompt);
      const turnIdx = Number(run.turn_index ?? 0);
      const leadProvider = run.lead_provider ? String(run.lead_provider) : "unknown";

      // Read the first status-like event for a brief summary
      const events = this.db
        .prepare("SELECT payload, type FROM run_events WHERE run_id = ? ORDER BY seq ASC LIMIT 5")
        .all(runId) as Array<Record<string, unknown>>;

      let summaryText = "";
      for (const ev of events) {
        const payload = ev.payload ? (JSON.parse(String(ev.payload)) as Record<string, unknown>) : {};
        const msg = typeof payload.message === "string" ? payload.message : "";
        if (msg && msg.length > 0) {
          summaryText = msg.slice(0, 200);
          break;
        }
      }

      const line = summaryText
        ? `Turn ${turnIdx} (${leadProvider}): ${prompt.slice(0, 100)} → ${summaryText}`
        : `Turn ${turnIdx} (${leadProvider}): ${prompt.slice(0, 100)}`;

      summaryParts.push(line);
      totalTokens += Math.ceil(line.length / 4);
    }

    const summary = summaryParts.join("\n");
    const id = `cmp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();
    const runIdsJson = JSON.stringify(compactedRunIds);

    this.db
      .prepare(
        `INSERT INTO session_compacts (id, session_id, turn_range_start, turn_range_end, summary, token_count, compacted_run_ids, created_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, sessionId, turnRangeStart, turnRangeEnd, summary, totalTokens, runIdsJson, now, createdBy);

    return this.getSessionCompact(id)!;
  }

  getSessionCompacts(sessionId: string): PersistedSessionCompact[] {
    const rows = this.db
      .prepare("SELECT * FROM session_compacts WHERE session_id = ? ORDER BY created_at DESC")
      .all(sessionId) as Array<Record<string, unknown>>;
    return rows.map(toSessionCompact);
  }

  getSessionCompact(id: string): PersistedSessionCompact | undefined {
    const row = this.db
      .prepare("SELECT * FROM session_compacts WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return row ? toSessionCompact(row) : undefined;
  }

  deleteSessionCompact(id: string): boolean {
    const result = this.db.prepare("DELETE FROM session_compacts WHERE id = ?").run(id);
    return result.changes > 0;
  }

  saveContextItem(input: CreateContextItemInput): PersistedContextItem {
    const id = input.id ?? randomUUID();
    const now = new Date().toISOString();
    const scope = input.scope ?? "session";
    const enabled = input.enabled ?? true;

    this.db
      .prepare(
        `INSERT INTO context_items (id, session_id, type, source, added_at, scope, tokens_estimated, measurement_method, enabled)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.sessionId,
        input.type,
        input.source,
        now,
        scope,
        input.tokensEstimated ?? null,
        input.measurementMethod ?? null,
        enabled ? 1 : 0,
      );

    return this.getContextItem(id)!;
  }

  getContextItem(id: string): PersistedContextItem | undefined {
    const row = this.db
      .prepare("SELECT * FROM context_items WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return row ? toContextItem(row) : undefined;
  }

  listContextItems(sessionId: string): PersistedContextItem[] {
    const rows = this.db
      .prepare("SELECT * FROM context_items WHERE session_id = ? ORDER BY added_at ASC")
      .all(sessionId) as Array<Record<string, unknown>>;
    return rows.map(toContextItem);
  }

  deleteContextItem(id: string): boolean {
    const result = this.db.prepare("DELETE FROM context_items WHERE id = ?").run(id);
    return result.changes > 0;
  }

  updateContextItemEnabled(id: string, enabled: boolean): PersistedContextItem | undefined {
    this.db.prepare("UPDATE context_items SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, id);
    return this.getContextItem(id);
  }

  getSessionContextMetrics(sessionId: string): { totalTokens: number; measurementMethod: string; enabledItemCount: number; totalItemCount: number } {
    const all = this.db
      .prepare("SELECT tokens_estimated, measurement_method, enabled FROM context_items WHERE session_id = ? ORDER BY added_at ASC")
      .all(sessionId) as Array<Record<string, unknown>>;
    const enabledItems = all.filter((r) => Boolean(r.enabled));
    const totalTokens = enabledItems.reduce((sum, r) => {
      const t = r.tokens_estimated;
      return sum + (t !== null && t !== undefined ? Number(t) : 0);
    }, 0);
    const hasAnyEstimated = enabledItems.length === 0 || enabledItems.some((r) => r.measurement_method !== "measured");
    return {
      totalTokens,
      measurementMethod: hasAnyEstimated ? "estimated" : "measured",
      enabledItemCount: enabledItems.length,
      totalItemCount: all.length,
    };
  }

  createSessionConfig(input: CreateSessionConfigInput): SessionConfig {
    const now = new Date().toISOString();
    const revision = this.nextConfigRevision(input.sessionId);
    const provenance = input.provenance ?? "native";
    const missingFields = [
      ...(!input.mode ? ["mode" as const] : []),
      ...(!input.leadAgentId ? ["leadAgentId" as const] : []),
      ...(!input.workerAgentId ? ["workerAgentId" as const] : []),
      ...(!input.model ? ["model" as const] : []),
      ...(!input.reasoningLevel ? ["reasoningLevel" as const] : []),
      ...(!input.permission ? ["permission" as const] : []),
      ...(!input.approvalMode ? ["approvalMode" as const] : []),
      ...(!input.cwd ? ["cwd" as const] : []),
      ...(!input.baseBranch ? ["baseBranch" as const] : []),
    ];
    const completeness = missingFields.length === 0 ? "complete" : "partial";
    this.db
      .prepare(
        `INSERT INTO session_config (session_id, revision, mode, lead_agent_id, worker_agent_id,
          model, reasoning_level, permission, approval_mode, cwd, base_branch,
          provenance, completeness, missing_fields, created_at, changed_by, change_reason, collaboration_state)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.sessionId,
        revision,
        input.mode ?? null,
        input.leadAgentId ?? null,
        input.workerAgentId ?? null,
        input.model ?? null,
        input.reasoningLevel ?? null,
        input.permission ?? null,
        input.approvalMode ?? null,
        input.cwd ?? null,
        input.baseBranch ?? null,
        provenance,
        completeness,
        JSON.stringify(missingFields),
        now,
        input.changedBy ?? null,
        input.changeReason ?? null,
        input.collaborationState ?? null,
      );
    return this.getSessionConfig(input.sessionId)!;
  }

  private nextConfigRevision(sessionId: string): number {
    const row = this.db
      .prepare("SELECT COALESCE(MAX(revision), 0) + 1 AS next FROM session_config WHERE session_id = ?")
      .get(sessionId) as { next: number };
    return Number(row.next);
  }

  getSessionConfig(sessionId: string): SessionConfig | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM session_config WHERE session_id = ? ORDER BY revision DESC LIMIT 1",
      )
      .get(sessionId) as Record<string, unknown> | undefined;
    return row ? toSessionConfig(row) : undefined;
  }

  listSessionConfigs(sessionId: string): SessionConfig[] {
    const rows = this.db
      .prepare("SELECT * FROM session_config WHERE session_id = ? ORDER BY revision ASC")
      .all(sessionId) as Array<Record<string, unknown>>;
    return rows.map(toSessionConfig);
  }

  countSessionRuns(sessionId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS cnt FROM runs WHERE session_id = ?")
      .get(sessionId) as { cnt: number };
    return Number(row.cnt);
  }

  recordBinding(
    bremioSessionId: string,
    agentId: string,
    transport: string,
    turnIndex: number,
  ): ProviderSessionBinding {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO provider_session_binding
           (bremio_session_id, agent_id, transport, status, turn_index, created_at, last_used_at)
         VALUES (?, ?, ?, 'active', ?, ?, ?)`,
      )
      .run(bremioSessionId, agentId, transport, turnIndex, now, now);
    return this.getBindings(bremioSessionId).find((b) => b.agentId === agentId)!;
  }

  setBindingStatus(input: SetBindingStatusInput): ProviderSessionBinding | undefined {
    const now = new Date().toISOString();
    if (input.nativeSessionId !== undefined) {
      this.db
        .prepare(
          `UPDATE provider_session_binding
           SET status = ?, native_session_id = ?, last_used_at = ?
           WHERE bremio_session_id = ? AND agent_id = ?`,
        )
        .run(input.status, input.nativeSessionId, now, input.bremioSessionId, input.agentId);
    } else {
      this.db
        .prepare(
          `UPDATE provider_session_binding
           SET status = ?, last_used_at = ?
           WHERE bremio_session_id = ? AND agent_id = ?`,
        )
        .run(input.status, now, input.bremioSessionId, input.agentId);
    }
    const row = this.db
      .prepare(
        "SELECT * FROM provider_session_binding WHERE bremio_session_id = ? AND agent_id = ?",
      )
      .get(input.bremioSessionId, input.agentId) as Record<string, unknown> | undefined;
    return row ? toProviderSessionBinding(row) : undefined;
  }

  getBindings(bremioSessionId: string): ProviderSessionBinding[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM provider_session_binding WHERE bremio_session_id = ? ORDER BY created_at ASC",
      )
      .all(bremioSessionId) as Array<Record<string, unknown>>;
    return rows.map(toProviderSessionBinding);
  }

  getActiveBindings(bremioSessionId: string): ProviderSessionBinding[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM provider_session_binding WHERE bremio_session_id = ? AND status = 'active' ORDER BY created_at ASC",
      )
      .all(bremioSessionId) as Array<Record<string, unknown>>;
    return rows.map(toProviderSessionBinding);
  }

  // ── Approval requests ──────────────────────────────────────────────

  createApprovalRequest(input: {
    id: string;
    sessionId: string;
    runId: string;
    actionClass: string;
    actionTarget: string;
    actionDescription: string;
    actionDigest: string;
    risk: string;
  }): PersistedApprovalRequest {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO approval_requests
           (id, session_id, run_id, action_class, action_target, action_description,
            action_digest, risk, state, requested_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .run(
        input.id, input.sessionId, input.runId,
        input.actionClass, input.actionTarget, input.actionDescription,
        input.actionDigest, input.risk, now,
      );
    return this.getApprovalRequest(input.id) as PersistedApprovalRequest;
  }

  getApprovalRequest(id: string): PersistedApprovalRequest | undefined {
    const row = this.db.prepare("SELECT * FROM approval_requests WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? toApprovalRequest(row) : undefined;
  }

  listApprovalRequests(filters: {
    sessionId?: string;
    runId?: string;
    state?: string;
  } = {}): PersistedApprovalRequest[] {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (filters.sessionId) { conditions.push("session_id = ?"); params.push(filters.sessionId); }
    if (filters.runId) { conditions.push("run_id = ?"); params.push(filters.runId); }
    if (filters.state) { conditions.push("state = ?"); params.push(filters.state); }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM approval_requests ${where} ORDER BY requested_at DESC`)
      .all(...(params as string[])) as Array<Record<string, unknown>>;
    return rows.map(toApprovalRequest);
  }

  decideApprovalRequest(input: {
    id: string;
    decision: "approved" | "rejected";
    decidedBy: string;
    decidedAt: string;
    reason?: string;
  }): PersistedApprovalRequest | undefined {
    const res = this.db
      .prepare(
        `UPDATE approval_requests
         SET state = ?, decided_at = ?, decided_by = ?, reason = ?
         WHERE id = ? AND state = 'pending'`,
      )
      .run(input.decision, input.decidedAt, input.decidedBy, input.reason ?? null, input.id);
    if (Number(res.changes) === 0) return undefined;
    return this.getApprovalRequest(input.id);
  }

  cancelApprovalRequest(id: string, cancelledBy?: string): PersistedApprovalRequest | undefined {
    const now = new Date().toISOString();
    const res = this.db
      .prepare(
        cancelledBy
          ? "UPDATE approval_requests SET state = 'cancelled', decided_at = ?, decided_by = ? WHERE id = ? AND state = 'pending'"
          : "UPDATE approval_requests SET state = 'cancelled', decided_at = ? WHERE id = ? AND state = 'pending'",
      )
      .run(...(cancelledBy ? [now, cancelledBy, id] : [now, id]));
    if (Number(res.changes) === 0) return undefined;
    return this.getApprovalRequest(id);
  }

  // ── Audit log ─────────────────────────────────────────────────────

  listAuditEvents(filters: {
    sessionId?: string;
    limit?: number;
  } = {}): AuditEvent[] {
    const limit = filters.limit ?? 50;
    const results: AuditEvent[] = [];

    // Approval request decisions
    const reqRows = this.db
      .prepare(
        `SELECT 'approval_decision' AS kind, id, session_id, run_id, decided_at AS event_at,
                decided_by, state, reason, requested_at
         FROM approval_requests
         WHERE decided_at IS NOT NULL
           ${filters.sessionId ? "AND session_id = ?" : ""}
         ORDER BY decided_at DESC
         LIMIT ?`,
      )
      .all(...(filters.sessionId ? [filters.sessionId, limit] : [limit])) as Array<Record<string, unknown>>;
    for (const r of reqRows) {
      results.push({
        kind: "approval_decision",
        id: String(r.id),
        sessionId: String(r.session_id),
        runId: String(r.run_id),
        eventAt: String(r.event_at),
        decidedBy: r.decided_by ? String(r.decided_by) : undefined,
        state: String(r.state),
        reason: r.reason ? String(r.reason) : undefined,
      });
    }

    // Session config changes
    const cfgRows = this.db
      .prepare(
        `SELECT 'config_change' AS kind, session_id, revision, changed_by, change_reason, created_at AS event_at
         FROM session_config
         WHERE changed_by IS NOT NULL
           ${filters.sessionId ? "AND session_id = ?" : ""}
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(...(filters.sessionId ? [filters.sessionId, limit] : [limit])) as Array<Record<string, unknown>>;
    for (const c of cfgRows) {
      results.push({
        kind: "config_change",
        id: `rev-${c.revision}`,
        sessionId: String(c.session_id),
        eventAt: String(c.event_at),
        decidedBy: c.changed_by ? String(c.changed_by) : undefined,
        reason: c.change_reason ? String(c.change_reason) : undefined,
      });
    }

    // Sort all events by event_at descending, then take `limit`
    results.sort((a, b) => b.eventAt.localeCompare(a.eventAt));
    return results.slice(0, limit);
  }

  // --- Memory ---

  storeMemory(entry: MemoryEntry): void {
    if (entry.scope === "session") {
      throw new Error("Session memory must not be persisted to the daemon");
    }

    const isProject = entry.scope === "project";
    const table = isProject ? "project_memory" : "user_memory";
    
    // repository field is only on project_memory
    if (isProject) {
      this.db.prepare(
        `INSERT INTO ${table} (
          id, repository, source_kind, source_session_id, source_run_id, title, content,
          tags, created_at, updated_at, expires_at, visibility, review_state, reviewer,
          reviewed_at, review_note, metadata
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
          title = excluded.title, content = excluded.content, tags = excluded.tags,
          updated_at = excluded.updated_at, expires_at = excluded.expires_at,
          visibility = excluded.visibility, review_state = excluded.review_state,
          reviewer = excluded.reviewer, reviewed_at = excluded.reviewed_at,
          review_note = excluded.review_note, metadata = excluded.metadata`
      ).run(
        entry.id,
        entry.repository ?? "",
        entry.source.kind,
        "sessionId" in entry.source ? (entry.source as any).sessionId : null,
        "runId" in entry.source ? (entry.source as any).runId : null,
        entry.title,
        entry.content,
        JSON.stringify(entry.tags),
        entry.createdAt,
        entry.updatedAt,
        entry.expiresAt ?? null,
        entry.visibility ?? (isProject ? "shared" : "private"),
        entry.review?.state ?? "pending",
        entry.review?.reviewer ?? null,
        entry.review?.reviewedAt ?? null,
        entry.review?.note ?? null,
        JSON.stringify(entry.metadata)
      );
    } else {
      this.db.prepare(
        `INSERT INTO ${table} (
          id, source_kind, source_session_id, source_run_id, title, content,
          tags, created_at, updated_at, expires_at, visibility, review_state, reviewer,
          reviewed_at, review_note, metadata
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
          title = excluded.title, content = excluded.content, tags = excluded.tags,
          updated_at = excluded.updated_at, expires_at = excluded.expires_at,
          visibility = excluded.visibility, review_state = excluded.review_state,
          reviewer = excluded.reviewer, reviewed_at = excluded.reviewed_at,
          review_note = excluded.review_note, metadata = excluded.metadata`
      ).run(
        entry.id,
        entry.source.kind,
        "sessionId" in entry.source ? (entry.source as any).sessionId : null,
        "runId" in entry.source ? (entry.source as any).runId : null,
        entry.title,
        entry.content,
        JSON.stringify(entry.tags),
        entry.createdAt,
        entry.updatedAt,
        entry.expiresAt ?? null,
        entry.visibility ?? "private",
        entry.review?.state ?? "pending",
        entry.review?.reviewer ?? null,
        entry.review?.reviewedAt ?? null,
        entry.review?.note ?? null,
        JSON.stringify(entry.metadata)
      );
    }
  }

  getMemory(id: string): MemoryEntry | undefined {
    let row = this.db.prepare("SELECT * FROM project_memory WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (row) return toMemoryEntry(row, "project");

    row = this.db.prepare("SELECT * FROM user_memory WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (row) return toMemoryEntry(row, "user");

    return undefined;
  }

  deleteMemory(id: string): boolean {
    const p = this.db.prepare("DELETE FROM project_memory WHERE id = ?").run(id);
    if (p.changes > 0) return true;
    const u = this.db.prepare("DELETE FROM user_memory WHERE id = ?").run(id);
    return u.changes > 0;
  }

  reviewMemory(id: string, decision: { state: "approved" | "rejected"; reviewer: string; note?: string }): boolean {
    const now = new Date().toISOString();
    const p = this.db.prepare(
      "UPDATE project_memory SET review_state = ?, reviewer = ?, reviewed_at = ?, review_note = ? WHERE id = ?"
    ).run(decision.state, decision.reviewer, now, decision.note ?? null, id);
    if (p.changes > 0) return true;

    const u = this.db.prepare(
      "UPDATE user_memory SET review_state = ?, reviewer = ?, reviewed_at = ?, review_note = ? WHERE id = ?"
    ).run(decision.state, decision.reviewer, now, decision.note ?? null, id);
    return u.changes > 0;
  }

  addBlackboardEntry(entry: BlackboardEntry): void {
    if (this.#closed) return;
    this.db
      .prepare(
        "INSERT INTO run_blackboard (id, run_id, type, content, author, created_at, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)"
      )
      .run(
        entry.id,
        entry.runId,
        entry.kind,
        entry.content,
        entry.author,
        entry.createdAt,
        JSON.stringify(entry.metadata)
      );
  }

  queryBlackboard(runId: string): BlackboardEntry[] {
    if (this.#closed) return [];
    const rows = this.db
      .prepare("SELECT * FROM run_blackboard WHERE run_id = ? ORDER BY created_at ASC")
      .all(runId) as Array<{
      id: string;
      run_id: string;
      type: string;
      content: string;
      author: string;
      created_at: string;
      metadata: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      runId: r.run_id,
      kind: r.type as BlackboardEntryKind,
      content: r.content,
      author: r.author,
      createdAt: r.created_at,
      metadata: JSON.parse(r.metadata) as Record<string, unknown>,
    }));
  }

  queryMemory(filter: MemoryQuery & { repository?: string }): MemoryEntry[] {
    const scopes = filter.scopes ?? ["project", "user"];
    const results: MemoryEntry[] = [];

    const handleQuery = (scope: MemoryScope, table: string) => {
      let sql = `SELECT * FROM ${table} WHERE 1=1`;
      const params: any[] = [];

      if (scope === "project" && filter.repository) {
        sql += ` AND repository = ?`;
        params.push(filter.repository);
      }

      if (filter.sourceKinds && filter.sourceKinds.length > 0) {
        sql += ` AND source_kind IN (${filter.sourceKinds.map(() => "?").join(",")})`;
        params.push(...filter.sourceKinds);
      }

      if (filter.ids && filter.ids.length > 0) {
        sql += ` AND id IN (${filter.ids.map(() => "?").join(",")})`;
        params.push(...filter.ids);
      }

      let rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];

      // tags filter is implemented in JS for simplicity as SQLite JSON is complicated
      if (filter.tags && filter.tags.length > 0) {
        rows = rows.filter((r) => {
          const tags = parseJson(r.tags) as string[];
          return filter.tags!.some((t) => tags.includes(t));
        });
      }

      for (const row of rows) {
        results.push(toMemoryEntry(row, scope));
      }
    };

    if (scopes.includes("project")) handleQuery("project", "project_memory");
    if (scopes.includes("user")) handleQuery("user", "user_memory");

    if (filter.limit !== undefined && filter.limit >= 0) {
      return results.slice(0, filter.limit);
    }
    return results;
  // --- Task-scoped Messaging ---

  insertMessage(message: any): void {
    this.db
      .prepare(
        `INSERT INTO run_messages (
          id, run_id, source_task_id, target_id, act, payload, handled, hop_count, reply_to_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        message.id,
        message.runId,
        message.sourceTaskId,
        message.targetId,
        message.act,
        message.payload,
        message.handled ? 1 : 0,
        message.hopCount,
        message.replyToId || null,
        message.createdAt
      );
  }

  getUnresolvedMessages(runId: string): any[] {
    const rows = this.db
      .prepare("SELECT * FROM run_messages WHERE run_id = ? AND handled = 0 ORDER BY created_at ASC")
      .all(runId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      runId: String(row.run_id),
      sourceTaskId: String(row.source_task_id),
      targetId: String(row.target_id),
      act: String(row.act),
      payload: String(row.payload),
      handled: Boolean(row.handled),
      hopCount: Number(row.hop_count),
      replyToId: row.reply_to_id ? String(row.reply_to_id) : undefined,
      createdAt: String(row.created_at),
    }));
  }

  markMessageHandled(messageId: string): void {
    this.db.prepare("UPDATE run_messages SET handled = 1 WHERE id = ?").run(messageId);
  }
}

export interface AuditEvent {
  kind: "approval_decision" | "config_change";
  id: string;
  sessionId: string;
  runId?: string;
  eventAt: string;
  decidedBy?: string;
  state?: string;
  reason?: string;
}

export function truncateTitle(prompt: string, maxLen = 80): string {
  const firstLine = prompt.split("\n")[0] ?? prompt;
  if (firstLine.length <= maxLen) return firstLine;
  return firstLine.slice(0, maxLen - 3) + "...";
}

export function toMemoryEntry(row: Record<string, unknown>, scope: MemoryScope): MemoryEntry {
  return {
    id: String(row.id),
    scope,
    source: {
      kind: String(row.source_kind) as any,
      ...(row.source_session_id ? { sessionId: String(row.source_session_id) } : {}),
      ...(row.source_run_id ? { runId: String(row.source_run_id) } : {}),
    } as any,
    title: String(row.title),
    content: String(row.content),
    tags: parseJson(row.tags) as string[],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    ...(row.expires_at ? { expiresAt: String(row.expires_at) } : {}),
    metadata: parseJson(row.metadata) as Record<string, unknown>,
    ...(row.repository ? { repository: String(row.repository) } : {}),
    visibility: String(row.visibility) as any,
    review: {
      state: String(row.review_state) as any,
      ...(row.reviewer ? { reviewer: String(row.reviewer) } : {}),
      ...(row.reviewed_at ? { reviewedAt: String(row.reviewed_at) } : {}),
      ...(row.review_note ? { note: String(row.review_note) } : {}),
    },
  };
}

/** Derive a `RunStatus` from a legacy report's contents. */
export function deriveReportStatus(report: Record<string, unknown>): RunStatus {
  if (report.mode === "single") {
    const result = report.result as Record<string, unknown> | undefined;
    const st = typeof result?.status === "string" ? result.status : "";
    if (st === "completed") return "completed";
    if (st === "cancelled") return "cancelled";
    if (st === "failed" || st) return "failed";
  } else {
    // Team runs always reach a terminal quality-gate status.
    return "completed";
  }
  return "completed";
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

  // One transaction for the version steps and the version stamp together.
  // SQLite's DDL is transactional, so a crash mid-migration rolls all the way
  // back to the previous version instead of leaving a half-applied schema.
  // Without this, a crash after the ALTER was unrecoverable: the next open
  // re-ran it, SQLite answered "duplicate column name", and `RunStore.open`
  // threw forever — the daemon could not start and every run in the history
  // became unreachable. `addColumnIfMissing` additionally repairs a database
  // already left in that half-state by the earlier code.
  db.exec("BEGIN IMMEDIATE");
  try {
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

      addColumnIfMissing(db, "runs", "session_id", "TEXT REFERENCES sessions(id) ON DELETE CASCADE");
      addColumnIfMissing(db, "runs", "turn_index", "INTEGER NOT NULL DEFAULT 0");

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

    if (Number(current) < 3) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS session_context (
          session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          turn_index INTEGER NOT NULL,
          summary TEXT,
          provider_session_ids TEXT,
          created_at TEXT NOT NULL,
          PRIMARY KEY (session_id, turn_index)
        );
        CREATE INDEX IF NOT EXISTS idx_session_context_session ON session_context(session_id, turn_index);
      `);
    }

    if (Number(current) < 4) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS session_config (
          session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          revision INTEGER NOT NULL,
          mode TEXT,
          lead_agent_id TEXT,
          worker_agent_id TEXT,
          model TEXT,
          reasoning_level TEXT,
          permission TEXT,
          approval_mode TEXT,
          cwd TEXT,
          base_branch TEXT,
          created_at TEXT NOT NULL,
          PRIMARY KEY (session_id, revision)
        );
        CREATE INDEX IF NOT EXISTS idx_session_config_session ON session_config(session_id, revision DESC);
      `);

      // Backfill: derive config from each session's latest run's lead_provider and mode.
      const sessions = db
        .prepare(
          `SELECT s.id, r.lead_provider, r.mode, r.worker_providers, r.created_at
           FROM sessions s
           LEFT JOIN runs r ON r.session_id = s.id
           WHERE r.id IN (
             SELECT r2.id FROM runs r2
             WHERE r2.session_id = s.id
             ORDER BY r2.turn_index DESC
             LIMIT 1
           )`,
        )
        .all() as Array<{ id: string; lead_provider: string | null; mode: string | null; worker_providers: string | null; created_at: string }>;
      for (const s of sessions) {
        const workerIds = s.worker_providers ? (JSON.parse(s.worker_providers) as string[]) : undefined;
        db.prepare(
          `INSERT OR IGNORE INTO session_config (session_id, revision, mode, lead_agent_id,
            worker_agent_id, created_at)
           VALUES (?, 1, ?, ?, ?, ?)`,
        ).run(
          s.id,
          s.mode,
          s.lead_provider,
          workerIds?.[0] ?? null,
          s.created_at,
        );
      }
    }

    if (Number(current) < 5) {
      addColumnIfMissing(db, "session_config", "provenance", "TEXT NOT NULL DEFAULT 'legacy-derived'");
      addColumnIfMissing(db, "session_config", "completeness", "TEXT NOT NULL DEFAULT 'partial'");
      addColumnIfMissing(db, "session_config", "missing_fields", "TEXT NOT NULL DEFAULT '[]'");
      // Mark all existing backfilled rows as legacy-derived/partial with computed missing fields.
      // Columns that backfill never populated: model, reasoning_level, permission, approval_mode,
      // cwd, base_branch.
      db.exec(
        `UPDATE session_config SET
           provenance = 'legacy-derived',
           completeness = 'partial',
           missing_fields = '["model","reasoningLevel","permission","approvalMode","cwd","baseBranch"]'
         WHERE provenance IS NULL OR provenance = 'legacy-derived'`,
      );
    }

    if (Number(current) < 6) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS provider_session_binding (
          bremio_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          agent_id TEXT NOT NULL,
          transport TEXT NOT NULL,
          native_session_id TEXT,
          status TEXT NOT NULL DEFAULT 'active',
          turn_index INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          last_used_at TEXT NOT NULL,
          PRIMARY KEY (bremio_session_id, agent_id)
        );
      `);

      // Backfill bindings for existing sessions from their runs' providers.
      const backfillBindings = db
        .prepare(
          `SELECT r.session_id, r.lead_provider, r.worker_providers, r.turn_index, r.created_at
           FROM runs r
           WHERE r.session_id IS NOT NULL
           ORDER BY r.turn_index ASC`,
        )
        .all() as Array<{
          session_id: string;
          lead_provider: string | null;
          worker_providers: string | null;
          turn_index: number;
          created_at: string;
        }>;
      const seen = new Set<string>();
      for (const b of backfillBindings) {
        const agents: Array<{ id: string }> = [];
        if (b.lead_provider) agents.push({ id: b.lead_provider });
        if (b.worker_providers) {
          for (const w of JSON.parse(b.worker_providers) as string[]) {
            agents.push({ id: w });
          }
        }
        for (const a of agents) {
          const key = `${b.session_id}:${a.id}`;
          if (seen.has(key)) continue;
          seen.add(key);
          db.prepare(
            `INSERT OR IGNORE INTO provider_session_binding
               (bremio_session_id, agent_id, transport, status, turn_index, created_at, last_used_at)
             VALUES (?, ?, ?, 'active', ?, ?, ?)`,
          ).run(b.session_id, a.id, a.id, b.turn_index, b.created_at, b.created_at);
        }
      }
    }

    if (Number(current) < 7) {
      addColumnIfMissing(db, "sessions", "repository_id", "TEXT");
      // Backfill: set repository_id to the normalized repository_path for all
      // existing sessions, so existing sessions get a stable identity even
      // without re-deriving from git. A future online operation can refine
      // this by resolving the actual git identity.
      db.exec(
        `UPDATE sessions SET repository_id = RTRIM(LOWER(REPLACE(repository_path, '\\', '/')), '/')
         WHERE repository_id IS NULL`,
      );
    }

    if (Number(current) < 8) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS approval_requests (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          run_id TEXT NOT NULL,
          action_class TEXT NOT NULL,
          action_target TEXT NOT NULL,
          action_description TEXT NOT NULL,
          action_digest TEXT NOT NULL,
          risk TEXT NOT NULL DEFAULT 'low',
          state TEXT NOT NULL DEFAULT 'pending',
          requested_at TEXT NOT NULL,
          decided_at TEXT,
          decided_by TEXT,
          reason TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_approval_requests_session ON approval_requests(session_id);
        CREATE INDEX IF NOT EXISTS idx_approval_requests_run ON approval_requests(run_id);
        CREATE INDEX IF NOT EXISTS idx_approval_requests_state ON approval_requests(state);

        CREATE TABLE IF NOT EXISTS approval_grants (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          workspace_id TEXT,
          scope TEXT NOT NULL,
          action_class TEXT,
          target TEXT,
          expires_at TEXT NOT NULL,
          revoked_at TEXT,
          consumed_at TEXT,
          created_at TEXT NOT NULL,
          created_by TEXT NOT NULL,
          originating_digest TEXT,
          precedence INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_approval_grants_session ON approval_grants(session_id);
        CREATE INDEX IF NOT EXISTS idx_approval_grants_scope ON approval_grants(scope);
      `);
    }

    if (Number(current) < 9) {
      addColumnIfMissing(db, "session_config", "changed_by", "TEXT");
      addColumnIfMissing(db, "session_config", "change_reason", "TEXT");
      addColumnIfMissing(db, "approval_grants", "revoked_by", "TEXT");
      addColumnIfMissing(db, "approval_grants", "consumed_by", "TEXT");
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_approval_requests_decided_by ON approval_requests(decided_by)",
      );
    }

    if (Number(current) < 10) {
      addColumnIfMissing(db, "session_config", "collaboration_state", "TEXT");
      db.exec(
        `UPDATE session_config SET collaboration_state = CASE mode WHEN 'team' THEN 'colab' ELSE 'solo' END
         WHERE collaboration_state IS NULL`,
      );
    }

    if (Number(current) < 11) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS context_items (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          type TEXT NOT NULL,
          source TEXT NOT NULL,
          added_at TEXT NOT NULL,
          scope TEXT NOT NULL DEFAULT 'session',
          tokens_estimated INTEGER,
          enabled INTEGER NOT NULL DEFAULT 1
        );
        CREATE INDEX IF NOT EXISTS idx_context_items_session ON context_items(session_id);
      `);
    }

    if (Number(current) < 12) {
      addColumnIfMissing(db, "context_items", "measurement_method", "TEXT DEFAULT 'estimated'");
    }

    if (Number(current) < 13) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS session_compacts (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          turn_range_start INTEGER NOT NULL,
          turn_range_end INTEGER NOT NULL,
          summary TEXT NOT NULL,
          token_count INTEGER NOT NULL DEFAULT 0,
          measurement_method TEXT NOT NULL DEFAULT 'estimated',
          compacted_run_ids TEXT NOT NULL DEFAULT '[]',
          created_at TEXT NOT NULL,
          created_by TEXT NOT NULL DEFAULT 'manual'
        );
        CREATE INDEX IF NOT EXISTS idx_session_compacts_session ON session_compacts(session_id);
      `);
    }

    if (Number(current) < 14) {
      addColumnIfMissing(db, "sessions", "parent_session_id", "TEXT");
      addColumnIfMissing(db, "sessions", "forked_from_turn", "INTEGER");
      db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions(parent_session_id)");
    }

    if (Number(current) < 15) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS project_memory (
          id TEXT PRIMARY KEY,
          repository TEXT NOT NULL,
          source_kind TEXT NOT NULL,
          source_session_id TEXT,
          source_run_id TEXT,
          title TEXT NOT NULL,
          content TEXT NOT NULL,
          tags TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          expires_at TEXT,
          visibility TEXT NOT NULL DEFAULT 'shared',
          review_state TEXT NOT NULL DEFAULT 'pending',
          reviewer TEXT,
          reviewed_at TEXT,
          review_note TEXT,
          metadata TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_project_memory_repo ON project_memory(repository);

        CREATE TABLE IF NOT EXISTS user_memory (
          id TEXT PRIMARY KEY,
          source_kind TEXT NOT NULL,
          source_session_id TEXT,
          source_run_id TEXT,
          title TEXT NOT NULL,
          content TEXT NOT NULL,
          tags TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          expires_at TEXT,
          visibility TEXT NOT NULL DEFAULT 'private',
          review_state TEXT NOT NULL DEFAULT 'pending',
          reviewer TEXT,
          reviewed_at TEXT,
          review_note TEXT,
          metadata TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS run_blackboard (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
          type TEXT NOT NULL,
          content TEXT NOT NULL,
          created_at TEXT NOT NULL,
          metadata TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_run_blackboard_run ON run_blackboard(run_id);
      `);
    }

    if (Number(current) < 16) {
      addColumnIfMissing(db, "run_blackboard", "author", "TEXT NOT NULL DEFAULT 'orchestrator'");
    }

    if (Number(current) < 17) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS run_messages (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
          source_task_id TEXT NOT NULL,
          target_id TEXT NOT NULL,
          act TEXT NOT NULL,
          payload TEXT NOT NULL,
          handled INTEGER NOT NULL DEFAULT 0,
          hop_count INTEGER NOT NULL DEFAULT 0,
          reply_to_id TEXT,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_run_messages_run ON run_messages(run_id);
      `);
    }

    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/**
 * Add a column only when it is absent.
 *
 * `ALTER TABLE ... ADD COLUMN` is not idempotent — re-running it throws — so a
 * migration that is retried after an interrupted attempt must check first.
 */
function addColumnIfMissing(
  db: Database,
  table: string,
  column: string,
  definition: string,
): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (columns.some((entry) => entry.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function toSessionContext(row: Record<string, unknown>): PersistedSessionContext {
  const providerSessionIds = row.provider_session_ids
    ? (parseJson(row.provider_session_ids) as Record<string, string>)
    : undefined;

  return {
    sessionId: String(row.session_id),
    turnIndex: Number(row.turn_index),
    ...(row.summary !== null && row.summary !== undefined ? { summary: String(row.summary) } : {}),
    ...(providerSessionIds && Object.keys(providerSessionIds).length > 0 ? { providerSessionIds } : {}),
    createdAt: String(row.created_at),
  };
}

function toSessionCompact(row: Record<string, unknown>): PersistedSessionCompact {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    turnRangeStart: Number(row.turn_range_start),
    turnRangeEnd: Number(row.turn_range_end),
    summary: String(row.summary),
    tokenCount: Number(row.token_count),
    measurementMethod: String(row.measurement_method) as "estimated" | "measured",
    compactedRunIds: JSON.parse(String(row.compacted_run_ids)) as string[],
    createdAt: String(row.created_at),
    createdBy: String(row.created_by),
  };
}

function toContextItem(row: Record<string, unknown>): PersistedContextItem {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    type: String(row.type) as ContextItemType,
    source: String(row.source),
    addedAt: String(row.added_at),
    scope: String(row.scope) as ContextItemScope,
    ...(row.tokens_estimated !== null && row.tokens_estimated !== undefined
      ? { tokensEstimated: Number(row.tokens_estimated) }
      : {}),
    ...(row.measurement_method !== null && row.measurement_method !== undefined
      ? { measurementMethod: String(row.measurement_method) as "estimated" | "measured" }
      : {}),
    enabled: Boolean(row.enabled),
  };
}

function toSessionConfig(row: Record<string, unknown>): SessionConfig {
  return {
    sessionId: String(row.session_id),
    revision: Number(row.revision),
    ...(row.mode ? { mode: row.mode as "single" | "team" } : {}),
    ...(row.lead_agent_id ? { leadAgentId: String(row.lead_agent_id) } : {}),
    ...(row.worker_agent_id ? { workerAgentId: String(row.worker_agent_id) } : {}),
    ...(row.model ? { model: String(row.model) } : {}),
    ...(row.reasoning_level ? { reasoningLevel: String(row.reasoning_level) } : {}),
    ...(row.permission ? { permission: String(row.permission) } : {}),
    ...(row.approval_mode ? { approvalMode: String(row.approval_mode) } : {}),
    ...(row.cwd ? { cwd: String(row.cwd) } : {}),
    ...(row.base_branch ? { baseBranch: String(row.base_branch) } : {}),
    provenance: (row.provenance ?? "legacy-derived") as RecordProvenance,
    completeness: (row.completeness ?? "partial") as "complete" | "partial",
    missingFields: row.missing_fields
      ? (JSON.parse(String(row.missing_fields)) as string[])
      : [],
    createdAt: String(row.created_at),
    ...(row.changed_by ? { changedBy: String(row.changed_by) } : {}),
    ...(row.change_reason ? { changeReason: String(row.change_reason) } : {}),
    ...(row.collaboration_state ? { collaborationState: String(row.collaboration_state) } : {}),
  };
}

function toProviderSessionBinding(row: Record<string, unknown>): ProviderSessionBinding {
  return {
    bremioSessionId: String(row.bremio_session_id),
    agentId: String(row.agent_id),
    transport: String(row.transport),
    ...(row.native_session_id ? { nativeSessionId: String(row.native_session_id) } : {}),
    status: row.status as "active" | "lost" | "expired",
    turnIndex: Number(row.turn_index),
    createdAt: String(row.created_at),
    lastUsedAt: String(row.last_used_at),
  };
}

function toApprovalRequest(row: Record<string, unknown>): PersistedApprovalRequest {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    runId: String(row.run_id),
    actionClass: String(row.action_class),
    actionTarget: String(row.action_target),
    actionDescription: String(row.action_description),
    actionDigest: String(row.action_digest),
    risk: String(row.risk),
    state: String(row.state),
    requestedAt: String(row.requested_at),
    ...(row.decided_at ? { decidedAt: String(row.decided_at) } : {}),
    ...(row.decided_by ? { decidedBy: String(row.decided_by) } : {}),
    ...(row.reason ? { reason: String(row.reason) } : {}),
  };
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
