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
  type AgentAdapter,
  type ProcessSupervisor,
  type TerminationOutcome,
} from "@bremio/adapter-sdk";
import { AntigravityAdapter } from "@bremio/adapter-antigravity";
import { ClaudeAdapter } from "@bremio/adapter-claude";
import { CodexAdapter } from "@bremio/adapter-codex";
import { OpenCodeAdapter } from "@bremio/adapter-opencode";
import { MergeManager, WorktreeManager, type TaskWorktree } from "@bremio/workspace";
import {
  evaluateTransition,
  effectiveMode,
  defaultHysteresisFloor,
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
  type PersistedRun,
  type PersistedRunEvent,
  type PersistedSession,
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
  #accepting = true;
  #counter = 0;

  constructor(
    private readonly store: RunStore,
    private readonly supervisor: ProcessSupervisor = processSupervisor,
    /** Overridden only by tests, so the review path can run without a provider. */
    private readonly adapters: () => AgentAdapter[] = defaultAdapters,
  ) {}

  /**
   * Mark runs that were mid-flight when the previous process died.
   *
   * A run that was actively executing (`running`) had a child process we were
   * supervising — we lost track of that process, so the status is
   * `supervision_lost`. A run that was `queued` or `cancelling` (no active
   * execution) is marked `interrupted`.
   *
   * Neither is `failed` — the daemon dying says nothing about whether the task
   * itself was going to succeed, and the child process may still be alive.
   * `supervision_lost` is the honest answer: we simply do not know.
   */
  reconcileOnStartup(): PersistedRun[] {
    const stranded = this.store.nonTerminalRuns();
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

  sessionDetail(id: string): SessionDetail | undefined {
    return this.store.sessionDetail(id);
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
      ...(original.workerProviders?.[0] ? { workerId: original.workerProviders[0] } : {}),
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

  start(input: StartRunInput): PersistedRun {
    if (!this.#accepting) throw new Error("the daemon is shutting down and is not accepting runs");

    const resolved = this.#resolveMode(input);

    const id = `run-${Date.now().toString(36)}-${(this.#counter += 1).toString(36)}`;
    const run = this.store.createRun({
      id,
      mode: resolved.mode,
      repositoryPath: input.repoPath,
      prompt: input.prompt,
      leadProvider: input.agentId,
      ...(input.workerId ? { workerProviders: [input.workerId] } : {}),
      ...(input.retryOfRunId ? { retryOfRunId: input.retryOfRunId } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    });

    const controller = new AbortController();
    this.#controllers.set(id, controller);
    this.store.updateRun(id, { status: "running", startedAt: new Date().toISOString() });
    // Recorded as an event so the reason survives into history: a user looking
    // at an old run has to be able to see why it ran the way it did.
    if (resolved.reason) {
      this.#emit(id, { kind: "status", message: `auto: ${resolved.reason}` });
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
    this.#executions.set(id, this.#execute(id, { ...input, mode: resolved.mode }, controller));
    return this.store.getRun(id) ?? run;
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
    const registry = createRegistry(this.adapters());

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
            ...(input.workerId ? { workerId: input.workerId } : {}),
            ...(input.model ? { model: input.model } : {}),
            ...(input.reasoningLevel ? { reasoningLevel: input.reasoningLevel } : {}),
            ...(input.timeoutMs ? { taskTimeoutMs: input.timeoutMs } : {}),
            ...(input.maxConcurrency ? { maxConcurrency: input.maxConcurrency } : {}),
            ...(input.comparisonId ? { comparisonId: input.comparisonId } : {}),
            ...(input.controlMode ? { controlMode: input.controlMode } : {}),
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
