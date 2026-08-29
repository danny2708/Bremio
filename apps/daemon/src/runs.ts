import {
  createRegistry,
  ledgerPathFor,
  readLedgerSync,
  resolveAutoMode,
  runBremio,
  runSingleAgent,
  type BremioRunReport,
} from "@bremio/orchestrator";
import type { ReasoningLevel } from "@bremio/protocol";
import { createHash } from "node:crypto";
import {
  classifyAgentError,
  processSupervisor,
  PluginManager,
  type AgentAdapter,
  type ProcessSupervisor,
  type TerminationOutcome,
} from "@bremio/adapter-sdk";
import { RunToolset } from "./run-toolset";
import { AntigravityAdapter } from "@bremio/adapter-antigravity";
import { ClaudeAdapter } from "@bremio/adapter-claude";
import { CodexAdapter } from "@bremio/adapter-codex";
import { OpenCodeAdapter } from "@bremio/adapter-opencode";
import { MergeManager, WorktreeManager, type TaskWorktree } from "@bremio/workspace";
import {
  evaluateTransition,
  effectiveMode,
  defaultHysteresisFloor,
  shouldAutoCompact,
  DEFAULT_TRIGGER_FRACTION,
  type AutoCompactDecision,
  type CollaborationState,
  type TransitionApproval,
  type TransitionEvent,
  type TransitionResult,
} from "@bremio/policy";
import {
  isTerminal,
  type AuditEvent,
  type ContextItemType,
  type CreateContextItemInput,
  type CreateSessionConfigInput,
  type PersistedApprovalRequest,
  type PersistedContextItem,
  type PersistedSessionCompact,
  type PersistedRun,
  type PersistedRunEvent,
  type PersistedSession,
  type ProjectSessionGroup,
  type RunStatus,
  type RunStore,
  type SessionConfig,
  type SessionDetail,
} from "./storage";

export type { RunStatus };

/**
 * The wire shape clients already consume. Storage keeps its own normalized
 * `{type, payload}` rows; this is reconstructed on the way out so persistence
 * did not force a breaking protocol change in the same step.
 */
export interface RunEvent {
  seq: number;
  ts: number;
  kind:
    | "status"
    | "lead"
    | "plan"
    | "task-start"
    | "task-event"
    | "task-complete"
    | "review-requested"
    | "finished"
    | "failed"
    | "interrupted";
  message: string;
  taskId?: string;
  agentId?: string;
  data?: unknown;
}

export interface StartRunInput {
  /**
   * `auto` decides between Single and Team from this repository's calibration
   * evidence. It is resolved here rather than by each client so the CLI, the
   * TUI and the panel cannot reach different answers from the same ledger.
   */
  mode: "single" | "team" | "auto";
  repoPath: string;
  prompt: string;
  /** Single mode: the agent. Team mode: the lead. */
  agentId: string;
  workerId?: string;
  /** Explicit Team workers (Sprint 10 — S10-T7). */
  workerIds?: string[];
  model?: string;
  reasoningLevel?: ReasoningLevel;
  timeoutMs?: number;
  maxConcurrency?: number;
  comparisonId?: string;
  /** Set when this run was created by retrying another. */
  retryOfRunId?: string;
  /** Continues an existing session, becoming its next turn. */
  sessionId?: string;
  /**
   * How the agent accesses the workspace.
   * `"direct-workspace"` (default) — agent edits the working tree directly.
   * `"isolated-worktree"` — agent runs in a detached worktree; changes need
   * review before being applied to the main working tree.
   */
  workspaceStrategy?: "direct-workspace" | "isolated-worktree";
  /** Control mode for execution: plan | approve | autopilot. */
  controlMode?: import("@bremio/policy").ControlMode;
}

/**
 * Create a fully-configured PluginManager with all built-in adapters registered
 * and activated. The manager tracks each adapter through its lifecycle:
 * registered → activating → active.
 *
 * Plugins can be deactivated and re-activated at runtime, enabling dynamic
 * adapter enablement without a daemon restart.
 */
export function createDefaultPluginManager(): PluginManager {
  const mgr = new PluginManager();
  mgr.register({
    manifest: { id: "claude", displayName: "Claude", version: "1.0.0", adapterFactory: () => new ClaudeAdapter(), supportedRoles: ["lead", "planner", "implementer", "reviewer"], configurationSchema: {} },
  });
  mgr.register({
    manifest: { id: "codex", displayName: "Codex", version: "1.0.0", adapterFactory: () => new CodexAdapter(), supportedRoles: ["lead", "implementer", "reviewer", "tester"], configurationSchema: {} },
  });
  mgr.register({
    manifest: { id: "antigravity", displayName: "Antigravity", version: "1.0.0", adapterFactory: () => new AntigravityAdapter(), supportedRoles: ["lead", "implementer"], configurationSchema: {} },
  });
  mgr.register({
    manifest: { id: "opencode", displayName: "OpenCode", version: "1.0.0", adapterFactory: () => new OpenCodeAdapter(), supportedRoles: ["implementer", "reviewer", "tester"], configurationSchema: {} },
  });
  return mgr;
}

/**
 * Every adapter the daemon can execute.
 *
 * `/adapters` advertises this same list. They were two literals until S4-T4 made
 * the daemon the default path for `bremio run`: the route offered opencode while
 * the run path was built from three adapters, so choosing the advertised agent
 * failed with "not registered". One source removes the class of bug, not just
 * the instance.
 */
export function defaultAdapters(): AgentAdapter[] {
  return [
    new ClaudeAdapter(),
    new CodexAdapter(),
    new AntigravityAdapter(),
    new OpenCodeAdapter(),
  ];
}

type Listener = (event: RunEvent) => void;
type SessionListener = (event: SessionEvent) => void;

/** A run in flight, and who is working on what inside it (S10-T4). */
export interface ActiveRun {
  runId: string;
  sessionId?: string;
  repositoryPath: string;
  mode: "single" | "team";
  /** `running`, or `pending_approval` when it is blocked on a human. */
  status: RunStatus;
  prompt: string;
  startedAt?: string;
  leadProvider?: string;
  workerProviders: string[];
  tasksInFlight: Array<{ taskId: string; title: string; agentId?: string; since: number }>;
}

export interface SessionEvent {
  kind: "session-updated";
  sessionId: string;
  data?: Record<string, unknown>;
}

interface PendingReview {
  runId: string;
  requestId: string;
  report: BremioRunReport;
  mergeManager: MergeManager;
  baseBranch: string;
  taskBranch: string;
  worktreePath: string;
  resolve: (decision: "approved" | "rejected") => void;
}

/**
 * Owns run execution and its durable record.
 *
 * Everything a client can ask for after a restart is written to the store
 * before it is published, so history and the SSE backlog survive the process
 * that produced them. In-memory state is now only the live plumbing:
 * cancellation handles and current subscribers.
 */
export class RunRegistry {
  readonly #controllers = new Map<string, AbortController>();
  readonly #listeners = new Map<string, Set<Listener>>();
  readonly #sessionListeners = new Map<string, Set<SessionListener>>();
  /** In-flight terminations, awaited before a run is called cancelled. */
  readonly #terminations = new Map<string, Promise<TerminationOutcome>>();
  /**
   * In-flight executions. Awaiting a termination is not enough on shutdown:
   * the run records its terminal event *after* termination resolves, so
   * closing storage at that point loses the write — or throws on a closed
   * database, which is how this surfaced on Linux.
   */
  readonly #executions = new Map<string, Promise<void>>();
  /** Runs that already emitted a terminal event; nothing may follow one. */
  readonly #terminated = new Set<string>();
  /** Reviews awaiting user approval after an isolated-worktree run completed. */
  readonly #pendingReviews = new Map<string, PendingReview>();
  /**
   * The arguments a queued prompt was submitted with, until it runs.
   *
   * In memory rather than persisted: the run row records what a turn *was*,
   * not the request that produced it, and half of `StartRunInput` (model,
   * reasoning level, workspace strategy, control mode) has nowhere to live in
   * it. A restart therefore loses them, and `#drainQueue` refuses to guess.
   */
  readonly #queuedInputs = new Map<string, StartRunInput & { mode: "single" | "team" }>();
  #accepting = true;
  #counter = 0;

  constructor(
    private readonly store: RunStore,
    private readonly supervisor: ProcessSupervisor = processSupervisor,
    /** Overridden only by tests, so the review path can run without a provider. */
    private readonly adapters: () => AgentAdapter[] = defaultAdapters,
    /** Plugin manager for lifecycle-tracked adapter registration. When set,
     * its active adapters take precedence over `adapters()`. */
    private readonly pluginManager?: PluginManager,
  ) {}

  /**
   * The adapters a run will actually be executed with.
   *
   * `/adapters` reports this rather than building its own list. S8-T6 gave the
   * daemon a long-lived `PluginManager` whose plugins can be deactivated at
   * runtime, but left the route constructing a *fresh* manager and activating
   * everything on it — so a deactivated plugin kept being advertised as
   * available while the run path could no longer run it. That is the same
   * advertise/execute split S4-T4 introduced and S4-REVIEW closed; the parity
   * test survived because both sides still happened to name the same four ids.
   */
  executableAdapters(): AgentAdapter[] {
    return this.pluginManager
      ? [...this.pluginManager.getRegistry().values()]
      : this.adapters();
  }

  /**
   * Mark runs that were mid-flight when the previous process died.
   *
   * A run that was actively executing (`running`) had a child process we were
   * supervising — we lost track of that process, so the status is
   * `supervision_lost`. A run that was `cancelling` (no active execution) is
   * marked `interrupted`.
   *
   * Neither is `failed` — the daemon dying says nothing about whether the task
   * itself was going to succeed, and the child process may still be alive.
   * `supervision_lost` is the honest answer: we simply do not know.
   *
   * A `queued` run is left alone (S10-T2). It never started, so nothing about
   * it was interrupted: it is a prompt the user typed and Bremio has not run
   * yet. Marking it `interrupted` would discard work the user is still owed and
   * report a failure that did not happen. It stays queued, and stays held —
   * the turn it was waiting behind did not complete.
   */
  reconcileOnStartup(): PersistedRun[] {
    const stranded = this.store.nonTerminalRuns().filter((run) => run.status !== "queued");
    for (const run of stranded) {
      if (run.status === "running") {
        this.store.appendEventWithStatus(
          run.id,
          "interrupted",
          { message: "daemon restarted while a supervised run was executing; the child process may still be alive", reason: "daemon_restart" },
          {
            status: "supervision_lost",
            completedAt: new Date().toISOString(),
            failureCode: "supervision_lost",
            failureMessage: "the daemon restarted while a supervised run was executing; the child process may still be alive",
          },
        );
      } else {
        this.store.appendEventWithStatus(
          run.id,
          "interrupted",
          { message: "daemon restarted while this run was in flight", reason: "daemon_restart" },
          {
            status: "interrupted",
            completedAt: new Date().toISOString(),
            failureCode: "daemon_restart",
            failureMessage: "the daemon restarted while this run was in flight",
          },
        );
      }
    }
    return stranded;
  }

  /** Stop taking new work; in-flight runs continue until cancelled. */
  stopAccepting(): void {
    this.#accepting = false;
  }

  get accepting(): boolean {
    return this.#accepting;
  }

  list(repositoryPath?: string): PersistedRun[] {
    return this.store.listRuns(repositoryPath ? { repositoryPath } : {});
  }

  get(id: string): PersistedRun | undefined {
    return this.store.getRun(id);
  }

  events(id: string, afterSeq = 0): RunEvent[] {
    return this.store.readEvents(id, afterSeq).map(toWireEvent);
  }

  artifacts(id: string): ReturnType<RunStore["listArtifacts"]> {
    return this.store.listArtifacts(id);
  }

  /**
   * What a client may offer for this run.
   *
   * `canResume` is false because no adapter exposes a safe mid-run resume:
   * offering it would mean silently starting over while the button claimed
   * otherwise. Retry is honest about creating a new run.
   */
  recoveryOptions(id: string): {
    canRetry: boolean;
    canResume: boolean;
    canOpenWorkspace: boolean;
  } {
    const run = this.store.getRun(id);
    if (!run) return { canRetry: false, canResume: false, canOpenWorkspace: false };
    return {
      canRetry: isTerminal(run.status),
      canResume: false,
      canOpenWorkspace: this.store.listArtifacts(id).some((a) => a.kind === "worktree"),
    };
  }

  /**
   * Import legacy report.json files from .bremio/runs/ into the store.
   * Idempotent: reports already imported are skipped.
   */
  async importReports(repoPath: string): Promise<{ imported: number; skipped: number }> {
    const { listReports } = await import("@bremio/orchestrator");
    const reports = await listReports(repoPath);
    let imported = 0;
    let skipped = 0;
    for (const entry of reports) {
      const result = this.store.importReport(entry.runId, entry.report as unknown as Record<string, unknown>, repoPath);
      if (result.skipped) skipped++;
      else imported++;
    }
    return { imported, skipped };
  }

  sessions(repositoryPath: string): PersistedSession[] {
    return this.store.listSessions(repositoryPath);
  }

  groupedSessions(): ProjectSessionGroup[] {
    return this.store.listGroupedSessions();
  }

  sessionDetail(id: string): SessionDetail | undefined {
    return this.store.sessionDetail(id);
  }

  forkSession(sessionId: string, forkedFromTurn: number): SessionDetail {
    return this.store.forkSession(sessionId, forkedFromTurn);
  }

  getSessionConfig(sessionId: string): SessionConfig | undefined {
    return this.store.getSessionConfig(sessionId);
  }

  listSessionConfigs(sessionId: string): SessionConfig[] {
    return this.store.listSessionConfigs(sessionId);
  }

  createSessionConfig(input: CreateSessionConfigInput): SessionConfig {
    const config = this.store.createSessionConfig(input);
    this.#publishSession(input.sessionId, {
      kind: "session-updated",
      sessionId: input.sessionId,
      data: { configRevision: config.revision },
    });
    return config;
  }

  listContextItems(sessionId: string): PersistedContextItem[] {
    return this.store.listContextItems(sessionId);
  }

  getContextItem(id: string): PersistedContextItem | undefined {
    return this.store.getContextItem(id);
  }

  createContextItem(input: CreateContextItemInput): PersistedContextItem {
    const item = this.store.saveContextItem(input);
    this.#publishSession(input.sessionId, {
      kind: "session-updated",
      sessionId: input.sessionId,
      data: { contextItemAdded: item.id },
    });
    return item;
  }

  deleteContextItem(id: string): boolean {
    const item = this.store.getContextItem(id);
    if (!item) return false;
    const removed = this.store.deleteContextItem(id);
    if (removed) {
      this.#publishSession(item.sessionId, {
        kind: "session-updated",
        sessionId: item.sessionId,
        data: { contextItemRemoved: id },
      });
    }
    return removed;
  }

  updateContextItemEnabled(id: string, enabled: boolean): PersistedContextItem | undefined {
    const item = this.store.updateContextItemEnabled(id, enabled);
    if (item) {
      this.#publishSession(item.sessionId, {
        kind: "session-updated",
        sessionId: item.sessionId,
        data: { contextItemUpdated: id, enabled },
      });
    }
    return item;
  }

  getSessionContextMetrics(sessionId: string): { totalTokens: number; measurementMethod: string; enabledItemCount: number; totalItemCount: number } {
    return this.store.getSessionContextMetrics(sessionId);
  }

  compactSession(sessionId: string): PersistedSessionCompact {
    const compact = this.store.compactSession(sessionId);
    this.#publishSession(sessionId, {
      kind: "session-updated",
      sessionId,
      data: { compactId: compact.id, turnRange: [compact.turnRangeStart, compact.turnRangeEnd] },
    });
    return compact;
  }

  getSessionCompacts(sessionId: string): PersistedSessionCompact[] {
    return this.store.getSessionCompacts(sessionId);
  }

  deleteSessionCompact(id: string): boolean {
    const compact = this.store.getSessionCompact(id);
    if (!compact) return false;
    const removed = this.store.deleteSessionCompact(id);
    if (removed) {
      this.#publishSession(compact.sessionId, {
        kind: "session-updated",
        sessionId: compact.sessionId,
        data: { compactRemoved: id },
      });
    }
    return removed;
  }

  /**
   * Auto-compact the session if thresholds are met, before a continuation
   * builds its prior turns.
   *
   * Delegates to the same `tryAutoCompact` the tests drive. This class used to
   * carry its own copy — four private helpers plus a second `shouldAutoCompact`
   * call with its own hard-coded budget — described in `tryAutoCompact`'s doc
   * comment as "mirrors the logic in `RunRegistry.#autoCompactIfNeeded`". Two
   * copies of a decision, only one of them tested, is how the reset-fraction
   * contradiction reached production without a failing test.
   */
  #autoCompactIfNeeded(sessionId: string): void {
    const decision = tryAutoCompact(this.store, sessionId, { createdBy: "auto" });
    if (!decision.ok) return;
    this.#publishSession(sessionId, {
      kind: "session-updated",
      sessionId,
      data: { autoCompacted: true, reason: decision.reason },
    });
  }

  /**
   * Build priorTurns for session continuation, using compact summaries
   * for any turns covered by a session compact (S7-T6).
   *
   * Before building, auto-compacts if thresholds are met (S7-T7).
   *
   * Turns covered by a compact are replaced by a single elided entry with
   * the compact's summary. Non-compacted turns pass through verbatim with
   * their prompt.
   */
  private buildPriorTurns(sessionId: string): Array<{
    turnIndex: number;
    prompt: string;
    summary?: string;
    elided?: boolean;
  }> {
    this.#autoCompactIfNeeded(sessionId);
    return buildPriorTurnsFromStore(this.store, sessionId);
  }

  /**
   * Evaluate a Solo/Co-lab transition for a session and, if it fires, persist
   * the new collaboration state as a session-config revision.
   *
   * The state machine guards (topology edges + hysteresis + approval) are
   * evaluated in the pure `@bremio/policy` layer. This method reads the
   * current state from the store, calls the evaluator, and persists the
   * result — it does not invent any rules of its own.
   */
  evaluateSessionTransition(input: {
    sessionId: string;
    event: TransitionEvent;
    reason: string;
    turnsInStableMode?: number;
    minTurnsInMode?: number;
    approval?: TransitionApproval;
    changedBy?: string;
  }): TransitionResult & { config?: SessionConfig } {
    const config = this.store.getSessionConfig(input.sessionId);
    if (!config) return { ok: false, reason: `no config for session: ${input.sessionId}` };

    // Derive the current CollaborationState from the persisted value, or from
    // the execution mode (legacy configs written before the column existed).
    const from: CollaborationState = (
      config.collaborationState
      ?? (config.mode === "team" ? "colab" : "solo")
    ) as CollaborationState;

    const turnsInStableMode = input.turnsInStableMode ?? this.store.countSessionRuns(input.sessionId);

    const result = evaluateTransition({
      from,
      event: input.event,
      reason: input.reason,
      turnsInStableMode,
      minTurnsInMode: input.minTurnsInMode ?? defaultHysteresisFloor,
      approval: input.approval,
    });

    if (!result.ok) return result;

    // Persist the new state as the latest session-config revision.
    const newConfig = this.store.createSessionConfig({
      sessionId: input.sessionId,
      mode: config.mode,
      leadAgentId: config.leadAgentId,
      workerAgentId: config.workerAgentId,
      collaborationState: result.transition.to,
      changeReason: result.transition.reason,
      changedBy: input.changedBy ?? "system",
    });

    this.#publishSession(input.sessionId, {
      kind: "session-updated",
      sessionId: input.sessionId,
      data: {
        configRevision: newConfig.revision,
        transition: {
          from: result.transition.from,
          to: result.transition.to,
          event: result.transition.event,
          reason: result.transition.reason,
        },
      },
    });

    return { ok: true, transition: result.transition, config: newConfig };
  }

  // ── Approval requests ─────────────────────────────────────────────

  createApprovalRequest(input: {
    sessionId: string;
    runId: string;
    actionClass: string;
    actionTarget: string;
    actionDescription: string;
    actionDigest: string;
    risk: string;
  }): { request: PersistedApprovalRequest; autoDenied: boolean } {
    const id = `apr-${Date.now().toString(36)}-${(this.#counter += 1).toString(36)}`;
    const request = this.store.createApprovalRequest({ id, ...input });

    // Fail-closed: if no SSE subscriber is watching this run, auto-deny.
    const hasListener = this.#listeners.get(input.runId) !== undefined &&
      (this.#listeners.get(input.runId)?.size ?? 0) > 0;
    if (!hasListener) {
      const decided = this.store.decideApprovalRequest({
        id,
        decision: "rejected",
        decidedBy: "system",
        decidedAt: new Date().toISOString(),
        reason: "Non-interactive run — no client connected to approve",
      });
      return { request: decided ?? request, autoDenied: true };
    }

    return { request, autoDenied: false };
  }

  listApprovalRequests(filters: {
    sessionId?: string;
    runId?: string;
    state?: string;
  } = {}): PersistedApprovalRequest[] {
    return this.store.listApprovalRequests(filters);
  }

  decideApprovalRequest(input: {
    id: string;
    decision: "approved" | "rejected";
    decidedBy: string;
    reason?: string;
  }): PersistedApprovalRequest | undefined {
    return this.store.decideApprovalRequest({
      ...input,
      decidedAt: new Date().toISOString(),
    });
  }

  cancelApprovalRequest(id: string, cancelledBy?: string): PersistedApprovalRequest | undefined {
    return this.store.cancelApprovalRequest(id, cancelledBy);
  }

  getApprovalRequest(id: string): PersistedApprovalRequest | undefined {
    return this.store.getApprovalRequest(id);
  }

  listAuditEvents(filters: { sessionId?: string; limit?: number } = {}): AuditEvent[] {
    return this.store.listAuditEvents(filters);
  }

  /**
   * Start a fresh run from a finished one, linked by `retryOfRunId`.
   *
   * The original is never overwritten: its events are the record of what went
   * wrong, and a retry that erased them would destroy the reason for retrying.
   */
  retry(id: string): PersistedRun {
    const original = this.store.getRun(id);
    if (!original) throw new Error(`unknown run: ${id}`);
    if (!isTerminal(original.status)) {
      throw new Error(`run ${id} is still ${original.status}; cancel it before retrying`);
    }

    return this.start({
      mode: original.mode,
      repoPath: original.repositoryPath,
      prompt: original.prompt,
      agentId: original.leadProvider ?? "claude",
      ...(original.workerProviders?.length ? { workerIds: original.workerProviders } : {}),
      retryOfRunId: original.id,
    });
  }

  /** Replay from the store, then receive live events. Returns an unsubscribe. */
  subscribe(id: string, listener: Listener, afterSeq = 0): () => void {
    if (!this.store.getRun(id)) throw new Error(`unknown run: ${id}`);
    for (const event of this.store.readEvents(id, afterSeq)) listener(toWireEvent(event));

    const set = this.#listeners.get(id) ?? new Set<Listener>();
    set.add(listener);
    this.#listeners.set(id, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.#listeners.delete(id);
    };
  }

  /** Subscribe to session-level events (no replay — notification-only). */
  subscribeSession(sessionId: string, listener: SessionListener): () => void {
    const set = this.#sessionListeners.get(sessionId) ?? new Set<SessionListener>();
    set.add(listener);
    this.#sessionListeners.set(sessionId, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.#sessionListeners.delete(sessionId);
    };
  }

  /**
   * Request cancellation.
   *
   * The run moves to `cancelling`, not `cancelled`: until the supervisor
   * confirms the process tree is gone, claiming it stopped would be a lie the
   * user acts on — closing the panel while `codex` keeps writing to a worktree.
   * `#execute` waits on this outcome before recording a terminal status.
   */
  cancel(id: string): boolean {
    const controller = this.#controllers.get(id);
    if (!controller || controller.signal.aborted) return false;

    this.#emit(id, { kind: "status", message: "cancelling — waiting for processes to stop" });
    this.store.updateRun(id, { status: "cancelling" });
    controller.abort();
    this.#terminations.set(id, this.supervisor.terminate(id));
    return true;
  }

  /** Cancel everything in flight, for a graceful shutdown. */
  cancelAll(): number {
    let cancelled = 0;
    for (const id of [...this.#controllers.keys()]) {
      if (this.cancel(id)) cancelled += 1;
    }
    return cancelled;
  }

  /**
   * Wait for every in-flight cancellation to settle, so shutdown does not exit
   * while child processes are still being torn down.
   *
   * Executions are awaited too, not just terminations: a run writes its
   * terminal event after termination resolves, and closing storage in that gap
   * either loses the record or throws on a closed database.
   */
  async awaitCancellations(): Promise<TerminationOutcome[]> {
    const outcomes = await Promise.all([...this.#terminations.values()]);
    await Promise.allSettled([...this.#executions.values()]);
    return outcomes;
  }

  get activeCount(): number {
    return this.#controllers.size;
  }

  /**
   * Every run currently in flight, with who is working on what (S10-T4).
   *
   * `activeCount` was the only window into this, and a number cannot tell you
   * that a Co-lab run has two workers, one of them stuck on a task since three
   * minutes ago. Derived from the run's own events rather than a parallel
   * in-memory map: a second copy of "what is each agent doing" is a copy that
   * can disagree with the transcript, and the transcript is what the user will
   * read afterwards.
   *
   * `pending_approval` runs are included and say so. Their execution really is
   * still alive — it is blocked on a human — and hiding them would make a run
   * that is waiting for *you* look like a run that finished.
   */
  activeRuns(): ActiveRun[] {
    const active: ActiveRun[] = [];
    for (const id of this.#controllers.keys()) {
      const run = this.store.getRun(id);
      if (!run) continue;
      active.push({
        runId: id,
        ...(run.sessionId ? { sessionId: run.sessionId } : {}),
        repositoryPath: run.repositoryPath,
        mode: run.mode,
        status: run.status,
        prompt: run.prompt,
        ...(run.startedAt ? { startedAt: run.startedAt } : {}),
        ...(run.leadProvider ? { leadProvider: run.leadProvider } : {}),
        workerProviders: run.workerProviders ?? [],
        tasksInFlight: this.#tasksInFlight(id),
      });
    }
    return active;
  }

  /**
   * The tasks a run has started and not yet finished.
   *
   * A task-start with no matching task-complete is work in progress; anything
   * else has either not begun or is over. Nothing here guesses: a task whose
   * agent the events never named is reported without one rather than being
   * attributed to the lead.
   */
  #tasksInFlight(runId: string): Array<{ taskId: string; title: string; agentId?: string; since: number }> {
    const running = new Map<string, { taskId: string; title: string; agentId?: string; since: number }>();
    for (const event of this.store.readEvents(runId)) {
      const payload = (event.payload ?? {}) as { taskId?: string; agentId?: string; message?: string };
      const taskId = payload.taskId;
      if (!taskId) continue;
      if (event.type === "task-start") {
        running.set(taskId, {
          taskId,
          title: payload.message ?? taskId,
          ...(payload.agentId ? { agentId: payload.agentId } : {}),
          since: Date.parse(event.timestamp),
        });
      } else if (event.type === "task-complete") {
        running.delete(taskId);
      }
    }
    return [...running.values()];
  }

  start(input: StartRunInput): PersistedRun {
    if (!this.#accepting) throw new Error("the daemon is shutting down and is not accepting runs");

    const resolved = this.#resolveMode(input);

    const id = `run-${Date.now().toString(36)}-${(this.#counter += 1).toString(36)}`;
    const rawWorkers = input.workerIds?.length
      ? input.workerIds
      : (input.workerId ? [input.workerId] : []);
    const workerProviders = rawWorkers.length > 0 ? [...new Set(rawWorkers)] : undefined;

    const run = this.store.createRun({
      id,
      mode: resolved.mode,
      repositoryPath: input.repoPath,
      prompt: input.prompt,
      leadProvider: input.agentId,
      ...(workerProviders ? { workerProviders } : {}),
      ...(input.retryOfRunId ? { retryOfRunId: input.retryOfRunId } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    });

    // A second prompt for a session that is already busy waits its turn rather
    // than being refused or running concurrently (S10-T2). `createRun` already
    // writes it as `queued` with the next `turn_index`, so ordering is the
    // insertion order and needs nothing else. Remember the input: the queued
    // run has to execute later with the same arguments it was submitted with.
    if (input.sessionId) {
      const active = this.store.activeRunForSession(input.sessionId);
      if (active && active.id !== id) {
        this.#queuedInputs.set(id, { ...input, mode: resolved.mode });
        this.#publishSession(input.sessionId, {
          kind: "session-updated",
          sessionId: input.sessionId,
          data: { queuedRunId: id, queueDepth: this.store.queuedRunsForSession(input.sessionId).length },
        });
        return this.store.getRun(id) ?? run;
      }
    }

    this.#beginExecution(id, { ...input, mode: resolved.mode }, resolved.reason);
    return this.store.getRun(id) ?? run;
  }

  /**
   * Move a created run from `queued` to `running` and start executing it.
   *
   * Shared by `start` and by the queue drain so both paths mark the run,
   * announce it and execute it identically — a queued turn is the same turn,
   * only later.
   */
  #beginExecution(
    id: string,
    input: StartRunInput & { mode: "single" | "team" },
    autoReason?: string,
  ): void {
    const controller = new AbortController();
    this.#controllers.set(id, controller);
    this.store.updateRun(id, { status: "running", startedAt: new Date().toISOString() });
    // Recorded as an event so the reason survives into history: a user looking
    // at an old run has to be able to see why it ran the way it did.
    if (autoReason) {
      this.#emit(id, { kind: "status", message: `auto: ${autoReason}` });
    }
    // Broadcast to session subscribers so a second client refreshes its view.
    if (input.sessionId) {
      this.#publishSession(input.sessionId, {
        kind: "session-updated",
        sessionId: input.sessionId,
        data: { addedRunId: id, turnCount: this.store.sessionDetail(input.sessionId)?.turns.length },
      });
    }
    // Never rejects: #execute records failure as a run outcome.
    this.#executions.set(id, this.#execute(id, input, controller));
  }

  /** Prompts waiting behind the active turn of a session, oldest first. */
  queuedRuns(sessionId: string): PersistedRun[] {
    return this.store.queuedRunsForSession(sessionId);
  }

  /**
   * Drop a queued prompt before it runs.
   *
   * Only a `queued` run can be dropped — see `deleteQueuedRun`. Returns false
   * for anything that already executed rather than pretending to remove it.
   */
  removeQueuedRun(id: string): boolean {
    const run = this.store.getRun(id);
    if (!run || run.status !== "queued") return false;
    const removed = this.store.deleteQueuedRun(id);
    if (removed) {
      this.#queuedInputs.delete(id);
      if (run.sessionId) {
        this.#publishSession(run.sessionId, {
          kind: "session-updated",
          sessionId: run.sessionId,
          data: { removedQueuedRunId: id, queueDepth: this.store.queuedRunsForSession(run.sessionId).length },
        });
      }
    }
    return removed;
  }

  /**
   * Start the next queued prompt for a session, if the turn before it earned
   * that.
   *
   * Only a `completed` turn advances the queue. A cancelled, failed or
   * interrupted turn **holds** it: the queued prompts were written expecting
   * the previous turn to have worked, and running them against a state the user
   * just cancelled is precisely the "silently run the queued one" failure
   * S10-T2 forbids. Held prompts stay queued and visible, so nothing the user
   * typed is thrown away — they decide whether to release or remove them.
   */
  #drainQueue(sessionId: string, finishedStatus: RunStatus): void {
    if (!this.#accepting) return;

    const next = this.store.queuedRunsForSession(sessionId)[0];
    if (!next) return;

    if (finishedStatus !== "completed") {
      this.#publishSession(sessionId, {
        kind: "session-updated",
        sessionId,
        data: {
          queueHeld: true,
          reason: `the previous turn ended as ${finishedStatus}; ${this.store.queuedRunsForSession(sessionId).length} queued prompt(s) are waiting for you`,
        },
      });
      return;
    }

    const input = this.#queuedInputs.get(next.id);
    if (!input) {
      // The daemon restarted, so the arguments this prompt was submitted with
      // are gone. Reconstructing them from the run row would guess at model,
      // reasoning level and workspace strategy — the substitution this codebase
      // refuses to make. Hold instead and say why.
      this.#publishSession(sessionId, {
        kind: "session-updated",
        sessionId,
        data: {
          queueHeld: true,
          reason: "queued prompts were submitted before the daemon restarted; release them yourself so their settings are the ones you chose",
        },
      });
      return;
    }

    this.#queuedInputs.delete(next.id);
    this.#beginExecution(next.id, input);
  }

  /** Release a held queued prompt explicitly, using its original arguments. */
  releaseQueuedRun(id: string): { ok: true } | { ok: false; reason: string } {
    const run = this.store.getRun(id);
    if (!run || run.status !== "queued") return { ok: false, reason: `run ${id} is not queued` };
    if (run.sessionId && this.store.activeRunForSession(run.sessionId)) {
      return { ok: false, reason: "this session already has a turn in flight" };
    }
    // Only the head may go. The panel offers Run on the first entry alone, but
    // enforcing that in the panel only would leave the route able to reorder a
    // conversation — and turn order is what makes a transcript mean anything.
    if (run.sessionId) {
      const head = this.store.queuedRunsForSession(run.sessionId)[0];
      if (head && head.id !== id) {
        return {
          ok: false,
          reason: `run ${id} is not next in the queue; release "${head.prompt.slice(0, 40)}" first or remove it`,
        };
      }
    }
    const input = this.#queuedInputs.get(id);
    if (!input) {
      return {
        ok: false,
        reason: "the arguments this prompt was submitted with are gone (the daemon restarted); start it as a new turn instead",
      };
    }
    this.#queuedInputs.delete(id);
    this.#beginExecution(id, input);
    return { ok: true };
  }

  /**
   * Turn `auto` into the mode that will actually run.
   *
   * Fails closed to Single: an unreadable ledger is not evidence that Team is
   * worth its coordination cost, and the reason says so rather than leaving the
   * user to guess why they got Single.
   */
  #resolveMode(input: StartRunInput): { mode: "single" | "team"; reason?: string } {
    if (input.mode !== "auto") return { mode: input.mode };
    try {
      const entries = readLedgerSync(ledgerPathFor(input.repoPath));
      const result = resolveAutoMode(entries);
      return { mode: result.mode, reason: result.reason };
    } catch (err) {
      return {
        mode: "single",
        reason: `selected Single — could not read the ledger (${(err as Error).message})`,
      };
    }
  }

  /**
   * Persist first, then publish. A subscriber must never see an event that a
   * later reader cannot replay, so the durable write is what makes it real.
   */
  #emit(runId: string, event: Omit<RunEvent, "seq" | "ts">): void {
    // Nothing may follow a terminal event. A late line from an adapter that
    // did not stop cleanly would arrive after the stream closed, so a client
    // replaying from the store would see a different history than the one it
    // watched live.
    if (this.#terminated.has(runId) || this.#storeIsGone()) return;
    const { kind, ...rest } = event;
    const stored = this.store.appendEvent(runId, kind, rest);
    this.#publish(runId, toWireEvent(stored));
  }

  #emitTerminal(
    runId: string,
    event: Omit<RunEvent, "seq" | "ts">,
    status: RunStatus,
    patch: { finalSummary?: string; failureCode?: string; failureMessage?: string } = {},
  ): void {
    if (this.#terminated.has(runId) || this.#storeIsGone()) return;
    this.#terminated.add(runId);
    const { kind, ...rest } = event;
    const stored = this.store.appendEventWithStatus(runId, kind, rest, {
      status,
      completedAt: new Date().toISOString(),
      ...patch,
    });
    this.#publish(runId, toWireEvent(stored));
  }

  /** Storage is gone: the daemon is exiting and there is nothing left to record. */
  #storeIsGone(): boolean {
    return this.store.closed;
  }

  #publish(runId: string, event: RunEvent): void {
    for (const listener of this.#listeners.get(runId) ?? []) {
      try {
        listener(event);
      } catch {
        // one broken subscriber must not stop the others or the run
      }
    }
  }

  #publishSession(sessionId: string, event: SessionEvent): void {
    for (const listener of this.#sessionListeners.get(sessionId) ?? []) {
      try {
        listener(event);
      } catch {
        // one broken subscriber must not stop the others
      }
    }
  }

  // ── Review-before-apply helpers ──────────────────────────────────

  /**
   * Start a review cycle for an isolated-worktree run: create an approval
   * request, emit a "review-requested" event, set status to pending_approval,
   * and block until the user decides.
   */
  async #startReview(
    runId: string,
    sessionId: string,
    report: import("@bremio/orchestrator").SingleRunReport,
    repoPath: string,
  ): Promise<{
    decision: "approved" | "rejected";
    actionDigest: string;
    /** Rejected by the fail-closed rule rather than by a person. */
    unattended?: boolean;
  }> {
    const wt = report.worktree!;
    const baseBranch = await new MergeManager(repoPath).currentBranch();
    const diff = await new MergeManager(repoPath).getDiff(wt.branch, baseBranch);
    const actionDigest = computeDigest(diff.patch);

    const { request, autoDenied } = this.createApprovalRequest({
      sessionId,
      runId,
      actionClass: "write",
      actionTarget: wt.branch,
      actionDescription: `review-before-apply: ${report.result.filesChanged.length} files changed in ${wt.branch}`,
      actionDigest,
      risk: "medium",
    });

    // The fail-closed rule already decided this one: no client is subscribed,
    // so nothing will ever call `resolvePendingApproval`. Awaiting the promise
    // below would strand the run at `pending_approval` for the life of the
    // daemon, holding its worktree and never settling its execution.
    if (autoDenied) {
      this.#emit(runId, {
        kind: "review-requested",
        message: `approval required but no client was connected: ${wt.branch} left for manual review`,
        data: { requestId: request.id, branch: wt.branch, worktreePath: wt.path, autoDenied: true },
      });
      return { decision: "rejected", actionDigest, unattended: true };
    }

    this.store.updateRun(runId, { status: "pending_approval" });
    this.#emit(runId, {
      kind: "review-requested",
      message: `approval required: ${report.result.filesChanged.length} files changed`,
      data: {
        requestId: request.id,
        branch: wt.branch,
        worktreePath: wt.path,
        filesChanged: report.result.filesChanged,
        diffStat: diff.stat,
        diffPatch: diff.patch,
      },
    });

    const decision = await new Promise<"approved" | "rejected">((resolve) => {
      this.#pendingReviews.set(request.id, {
        runId,
        requestId: request.id,
        report,
        mergeManager: new MergeManager(repoPath),
        baseBranch,
        taskBranch: wt.branch,
        worktreePath: wt.path,
        resolve,
      });
    });

    return { decision, actionDigest };
  }

  /**
   * Resolve a pending review from a user decision.
   * Called by the approval route handler when a pending request is decided.
   * Returns true if a pending review was resolved.
   */
  resolvePendingApproval(requestId: string, decision: "approved" | "rejected"): boolean {
    const pending = this.#pendingReviews.get(requestId);
    if (!pending) return false;
    pending.resolve(decision);
    this.#pendingReviews.delete(requestId);
    return true;
  }

  async #execute(
    runId: string,
    input: StartRunInput,
    controller: AbortController,
  ): Promise<void> {
    const registry = createRegistry(this.executableAdapters());

    // Construct Sprint 8 tools wired to real policy evaluation and the S3
    // approval lifecycle. The tools are per-run and policy-bound, but no
    // adapter currently consumes them — they remain inert at their call sites
    // until a later task wires them into an adapter or orchestrator path.
    const toolset = new RunToolset({
      controlMode: input.controlMode ?? "autopilot",
    });

    // Build session continuation context when continuing an existing session
    const turnIndex = input.sessionId
      ? this.store.getRun(runId)?.turnIndex ?? 0
      : undefined;
    const priorTurns = input.sessionId ? this.buildPriorTurns(input.sessionId) : undefined;

    try {
      const report: BremioRunReport = input.mode === "single"
        ? await runSingleAgent({
            primaryAgentId: input.agentId,
            repoPath: input.repoPath,
            prompt: input.prompt,
            registry,
            signal: controller.signal,
            ...(input.model ? { model: input.model } : {}),
            ...(input.reasoningLevel ? { reasoningLevel: input.reasoningLevel } : {}),
            ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
            ...(input.comparisonId ? { comparisonId: input.comparisonId } : {}),
            ...(input.workspaceStrategy ? { workspaceStrategy: input.workspaceStrategy } : {}),
            ...(input.controlMode ? { controlMode: input.controlMode } : {}),
            ...(input.sessionId ? { sessionId: input.sessionId } : {}),
            ...(turnIndex !== undefined ? { turnIndex } : {}),
            ...(priorTurns !== undefined ? { priorTurns } : {}),
            hooks: {
              onStart: (id) =>
                this.#emit(runId, { kind: "status", message: `${id} started`, agentId: id }),
              onEvent: (event) =>
                this.#emit(runId, { kind: "task-event", message: describe(event), data: event }),
            },
          })
        : await runBremio({
            leadId: input.agentId,
            repoPath: input.repoPath,
            prompt: input.prompt,
            registry,
            signal: controller.signal,
            ...(input.workerIds?.length ? { workerIds: input.workerIds } : input.workerId ? { workerId: input.workerId } : {}),
            ...(input.model ? { model: input.model } : {}),
            ...(input.reasoningLevel ? { reasoningLevel: input.reasoningLevel } : {}),
            ...(input.timeoutMs ? { taskTimeoutMs: input.timeoutMs } : {}),
            ...(input.maxConcurrency ? { maxConcurrency: input.maxConcurrency } : {}),
            ...(input.comparisonId ? { comparisonId: input.comparisonId } : {}),
            ...(input.controlMode ? { controlMode: input.controlMode } : {}),
            ...(input.sessionId ? { sessionId: input.sessionId } : {}),
            ...(turnIndex !== undefined ? { turnIndex } : {}),
            ...(priorTurns !== undefined ? { priorTurns } : {}),
            hooks: {
              onLeadStart: (id) =>
                this.#emit(runId, { kind: "lead", message: `lead ${id} planning`, agentId: id }),
              onLeadEvent: (event) =>
                this.#emit(runId, { kind: "lead", message: describe(event), data: event }),
              onPlan: (plan, assign) =>
                this.#emit(runId, {
                  kind: "plan",
                  message: plan.summary,
                  data: { plan, assign: Object.fromEntries(assign) },
                }),
              onFallback: (reason, agentId) =>
                this.#emit(runId, {
                  kind: "status",
                  message: reason,
                  agentId,
                }),
              onTaskStart: (task, agentId) =>
                this.#emit(runId, {
                  kind: "task-start",
                  message: task.title,
                  taskId: task.id,
                  agentId,
                }),
              onEvent: (task, agentId, event) =>
                this.#emit(runId, {
                  kind: "task-event",
                  message: describe(event),
                  taskId: task.id,
                  agentId,
                  data: event,
                }),
              onTaskComplete: (result) =>
                this.#emit(runId, {
                  kind: "task-complete",
                  message: result.status,
                  taskId: result.taskId,
                  agentId: result.agentId,
                  data: result,
                }),
            },
          });

      this.#recordArtifacts(runId, report);
      this.store.updateRun(runId, { orchestratorRunId: report.runId });

      // ── Review-before-apply gate (S3-T4) ───────────────────────────
      // When the agent ran in an isolated worktree and completed, the
      // changes must be reviewed and approved before they reach the main
      // working tree.  The run stays at `pending_approval` until the user
      // decides via the approval protocol.
      if (
        !controller.signal.aborted &&
        input.workspaceStrategy === "isolated-worktree" &&
        report.mode === "single" &&
        report.worktree &&
        report.result.status === "completed"
      ) {
        const runSessionId = this.store.getRun(runId)?.sessionId ?? runId;
        const { decision, actionDigest, unattended } = await this.#startReview(runId, runSessionId, report, input.repoPath);
        if (decision === "approved") {
          // Verify the worktree hasn't drifted since approval: recompute the
          // diff and compare the digest. A mismatch means the changes the user
          // approved are not what would be merged.
          const mm = new MergeManager(input.repoPath);
          const baseBranch = await mm.currentBranch();
          const verifyDiff = await mm.getDiff(report.worktree!.branch, baseBranch);
          if (computeDigest(verifyDiff.patch) !== actionDigest) {
            await mm.cleanup(report.worktree.path, report.worktree.branch).catch(() => {});
            this.#emitTerminal(
              runId,
              { kind: "failed", message: "worktree content changed after approval", data: report },
              "failed",
              { failureCode: "review_drifted", failureMessage: "The worktree content changed after approval." },
            );
          } else {
            try {
              await mm.merge(report.worktree.branch, baseBranch);
              await mm.cleanup(report.worktree.path, report.worktree.branch);
            } catch {
              // Merge or cleanup failed — worktree left for manual resolution.
            }
            this.#emitTerminal(
              runId,
              { kind: "finished", message: "completed (reviewed)", data: report },
              "completed",
              { finalSummary: summarize(report) },
            );
          }
        } else if (unattended) {
          // Nobody saw these changes, so nobody decided to discard them. The
          // worktree stays put and the message says where to find it.
          const detail = `no client was connected to review the changes; they are kept on ${report.worktree.branch} at ${report.worktree.path}`;
          this.#emitTerminal(
            runId,
            { kind: "failed", message: detail, data: report },
            "failed",
            { failureCode: "review_unattended", failureMessage: detail },
          );
        } else {
          // Rejected: clean up the worktree without merging.
          try {
            const mm = new MergeManager(input.repoPath);
            await mm.cleanup(report.worktree.path, report.worktree.branch);
          } catch {
            // best-effort cleanup
          }
          this.#emitTerminal(
            runId,
            { kind: "failed", message: "changes rejected by reviewer", data: report },
            "failed",
            { failureCode: "review_rejected", failureMessage: "The worktree changes were not approved." },
          );
        }
        return;
      }

      if (controller.signal.aborted) {
        await this.#settleCancellation(runId, { kind: "finished", data: report });
      } else {
        this.#emitTerminal(
          runId,
          { kind: "finished", message: "completed", data: report },
          "completed",
          { finalSummary: summarize(report) },
        );
      }
    } catch (err) {
      if (controller.signal.aborted) {
        await this.#settleCancellation(runId, { kind: "failed" });
      } else {
        // Classify once here so the UI can say "rate limited" or "not signed
        // in" instead of showing the same generic failure for every cause.
        const classified = classifyAgentError(err, { provider: input.agentId });
        this.#emitTerminal(
          runId,
          {
            kind: "failed",
            message: classified.message,
            data: {
              code: classified.code,
              retryable: classified.retryable,
              ...(classified.retryAfterMs !== undefined
                ? { retryAfterMs: classified.retryAfterMs }
                : {}),
            },
          },
          "failed",
          { failureCode: classified.code, failureMessage: classified.message },
        );
      }
    } finally {
      this.#controllers.delete(runId);
      this.#terminations.delete(runId);
      this.#executions.delete(runId);
      this.supervisor.release(runId);

      // The session is free again, so the next queued prompt may go — but only
      // if this turn actually completed. Read the status back from the store
      // rather than inferring it from which branch above ran: cancellation and
      // review-drift both land here having written a status of their own.
      const finished = this.store.closed ? undefined : this.store.getRun(runId);
      if (finished?.sessionId && isTerminal(finished.status)) {
        this.#drainQueue(finished.sessionId, finished.status);
      }
    }
  }

  /**
   * Record a cancelled run only once the process tree is confirmed gone.
   *
   * If anything survived, the run becomes `cancellation_failed` and names the
   * surviving pids. Reporting `cancelled` in that case would tell the user the
   * work stopped while an agent kept editing their repository — the exact
   * failure this whole path exists to prevent.
   */
  async #settleCancellation(
    runId: string,
    event: { kind: RunEvent["kind"]; data?: unknown },
  ): Promise<void> {
    const outcome = await (this.#terminations.get(runId) ?? this.supervisor.terminate(runId));

    if (outcome.stopped) {
      this.#emitTerminal(
        runId,
        {
          kind: event.kind,
          message: "cancelled",
          ...(event.data !== undefined ? { data: event.data } : {}),
        },
        "cancelled",
        { failureCode: "cancelled", failureMessage: "cancelled by request" },
      );
      return;
    }

    const detail = `cancellation could not be confirmed: ${outcome.reason} (pids ${outcome.survivingPids.join(", ")})`;
    this.#emitTerminal(
      runId,
      {
        kind: "failed",
        message: detail,
        data: { code: "cancellation_failed", survivingPids: outcome.survivingPids },
      },
      "cancellation_failed",
      { failureCode: "cancellation_failed", failureMessage: detail },
    );
  }

  /**
   * Record where a run's outputs live rather than copying them into the
   * database: reports and worktrees are already files with their own lifecycle.
   */
  #recordArtifacts(runId: string, report: BremioRunReport): void {
    try {
      this.store.recordArtifact({ runId, kind: "report", path: `${report.runDir}/report.json` });
      if (report.mode === "team") {
        for (const entry of report.tasks) {
          if (entry.result.worktreePath) {
            this.store.recordArtifact({
              runId,
              kind: "worktree",
              path: entry.result.worktreePath,
              taskId: entry.task.id,
            });
          }
        }
      }
    } catch {
      // artifact bookkeeping is best-effort; it must never fail a finished run
    }
  }
}

/**
 * Build priorTurns for session continuation, using compact summaries
 * for any turns covered by a session compact (S7-T6).
 *
 * Turns covered by a compact are replaced by a single elided entry with
 * the compact's summary. Non-compacted turns pass through verbatim with
 * their prompt.
 *
 * Exported for testing.
 */
export function buildPriorTurnsFromStore(
  store: RunStore,
  sessionId: string,
): Array<{
  turnIndex: number;
  prompt: string;
  summary?: string;
  elided?: boolean;
}> {
  const detail = store.sessionDetail(sessionId);
  if (!detail || detail.turns.length === 0) return [];

  const compacts = store.getSessionCompacts(sessionId);
  const priorTurns: Array<{
    turnIndex: number;
    prompt: string;
    summary?: string;
    elided?: boolean;
  }> = [];

  const compactedTurns = new Set<number>();
  for (const c of compacts) {
    for (let i = c.turnRangeStart; i <= c.turnRangeEnd; i++) compactedTurns.add(i);
  }

  for (const turn of detail.turns) {
    if (compactedTurns.has(turn.turnIndex)) {
      const compact = compacts.find(
        (c) => turn.turnIndex >= c.turnRangeStart && turn.turnIndex <= c.turnRangeEnd,
      );
      if (compact && turn.turnIndex === compact.turnRangeStart) {
        priorTurns.push({
          turnIndex: compact.turnRangeStart,
          prompt: "",
          summary: compact.summary,
          elided: true,
        });
      }
    } else {
      priorTurns.push({
        turnIndex: turn.turnIndex,
        prompt: turn.prompt,
      });
    }
  }

  return priorTurns;
}

/**
 * Evaluate and optionally trigger auto-compaction for a session.
 *
 * The single implementation: `RunRegistry.#autoCompactIfNeeded` calls this
 * rather than keeping a parallel copy.
 */
export function tryAutoCompact(
  store: RunStore,
  sessionId: string,
  options: { budgetTokens?: number; createdBy?: "manual" | "auto" } = {},
): AutoCompactDecision {
  const budgetTokens = options.budgetTokens ?? 100_000;
  const detail = store.sessionDetail(sessionId);
  if (!detail || detail.turns.length === 0) {
    return { ok: false, reason: "session has no turns" };
  }

  const compacts = store.getSessionCompacts(sessionId);
  const compactedTurns = new Set<number>();
  let compactTokenSum = 0;
  for (const c of compacts) {
    for (let i = c.turnRangeStart; i <= c.turnRangeEnd; i++) compactedTurns.add(i);
    compactTokenSum += c.tokenCount;
  }

  let nonCompactedTokens = 0;
  for (const turn of detail.turns) {
    if (!compactedTurns.has(turn.turnIndex)) {
      nonCompactedTokens += Math.ceil(turn.prompt.length / 4);
    }
  }
  const totalTokens = compactTokenSum + nonCompactedTokens;
  const measurementMethod: "estimated" | "measured" = "estimated";

  const runsCount = store.countSessionRuns(sessionId);
  const latestTurnIndex = runsCount - 1;
  let compactableTurns = 0;
  for (let i = 0; i < latestTurnIndex; i++) {
    if (!compactedTurns.has(i)) compactableTurns++;
  }

  const decision = shouldAutoCompact({
    usedTokens: totalTokens,
    budgetTokens,
    measurementMethod,
    compactableTurns,
  });

  if (decision.ok) {
    store.compactSession(sessionId, options.createdBy ?? "auto");
  }

  return decision;
}

function summarize(report: BremioRunReport): string {
  if (report.mode === "single") return report.result.summary.slice(0, 500);
  return report.plan.summary.slice(0, 500);
}

/** Hash a diff patch into a verifiable action digest. */
export function computeDigest(patch: string): string {
  return `sha256:${createHash("sha256").update(patch, "utf-8").digest("hex")}`;
}

function toWireEvent(event: PersistedRunEvent): RunEvent {
  const payload = (event.payload ?? {}) as Omit<RunEvent, "seq" | "ts" | "kind">;
  return {
    seq: event.seq,
    ts: Date.parse(event.timestamp),
    kind: event.type as RunEvent["kind"],
    message: payload.message ?? "",
    ...(payload.taskId ? { taskId: payload.taskId } : {}),
    ...(payload.agentId ? { agentId: payload.agentId } : {}),
    ...(payload.data !== undefined ? { data: payload.data } : {}),
  };
}

/** True once a run can no longer change without an explicit new action. */
export function runIsTerminal(run: PersistedRun): boolean {
  return isTerminal(run.status);
}

function describe(event: { type: string; [key: string]: unknown }): string {
  if (event.type === "message" && typeof event.text === "string") {
    return event.text.split("\n")[0]?.slice(0, 200) ?? "";
  }
  if (event.type === "tool_use" && typeof event.name === "string") return `tool: ${event.name}`;
  if (event.type === "completed") return "completed";
  return event.type;
}
