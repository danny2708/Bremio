import {
  createRegistry,
  runBremio,
  runSingleAgent,
  type BremioRunReport,
} from "@bremio/orchestrator";
import type { ReasoningLevel } from "@bremio/protocol";
import { classifyAgentError } from "@bremio/adapter-sdk";
import { AntigravityAdapter } from "@bremio/adapter-antigravity";
import { ClaudeAdapter } from "@bremio/adapter-claude";
import { CodexAdapter } from "@bremio/adapter-codex";
import {
  isTerminal,
  type PersistedRun,
  type PersistedRunEvent,
  type RunStatus,
  type RunStore,
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
    | "finished"
    | "failed"
    | "interrupted";
  message: string;
  taskId?: string;
  agentId?: string;
  data?: unknown;
}

export interface StartRunInput {
  mode: "single" | "team";
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
}

type Listener = (event: RunEvent) => void;

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
  #accepting = true;
  #counter = 0;

  constructor(private readonly store: RunStore) {}

  /**
   * Mark runs that were mid-flight when the previous process died.
   *
   * Without this, persistence would be a regression: a crashed run used to
   * vanish with the RAM that held it, and would now sit at `running` forever.
   * `interrupted` is deliberately not `failed` — the daemon dying says nothing
   * about whether the task itself was going to succeed.
   */
  reconcileOnStartup(): PersistedRun[] {
    const stranded = this.store.nonTerminalRuns();
    for (const run of stranded) {
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

  cancel(id: string): boolean {
    const controller = this.#controllers.get(id);
    if (!controller || controller.signal.aborted) return false;
    controller.abort();
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

  get activeCount(): number {
    return this.#controllers.size;
  }

  start(input: StartRunInput): PersistedRun {
    if (!this.#accepting) throw new Error("the daemon is shutting down and is not accepting runs");

    const id = `run-${Date.now().toString(36)}-${(this.#counter += 1).toString(36)}`;
    const run = this.store.createRun({
      id,
      mode: input.mode,
      repositoryPath: input.repoPath,
      prompt: input.prompt,
      leadProvider: input.agentId,
      ...(input.workerId ? { workerProviders: [input.workerId] } : {}),
      ...(input.retryOfRunId ? { retryOfRunId: input.retryOfRunId } : {}),
    });

    const controller = new AbortController();
    this.#controllers.set(id, controller);
    this.store.updateRun(id, { status: "running", startedAt: new Date().toISOString() });
    void this.#execute(id, input, controller);
    return this.store.getRun(id) ?? run;
  }

  /**
   * Persist first, then publish. A subscriber must never see an event that a
   * later reader cannot replay, so the durable write is what makes it real.
   */
  #emit(runId: string, event: Omit<RunEvent, "seq" | "ts">): void {
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
    const { kind, ...rest } = event;
    const stored = this.store.appendEventWithStatus(runId, kind, rest, {
      status,
      completedAt: new Date().toISOString(),
      ...patch,
    });
    this.#publish(runId, toWireEvent(stored));
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

  async #execute(
    runId: string,
    input: StartRunInput,
    controller: AbortController,
  ): Promise<void> {
    const registry = createRegistry([
      new ClaudeAdapter(),
      new CodexAdapter(),
      new AntigravityAdapter(),
    ]);

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
      const status: RunStatus = controller.signal.aborted ? "cancelled" : "completed";
      this.store.updateRun(runId, { orchestratorRunId: report.runId });
      this.#emitTerminal(
        runId,
        { kind: "finished", message: status, data: report },
        status,
        { finalSummary: summarize(report) },
      );
    } catch (err) {
      const cancelled = controller.signal.aborted;
      // Classify once here so the UI can say "rate limited" or "not signed in"
      // instead of showing the same generic failure for every cause.
      const classified = classifyAgentError(err, { provider: input.agentId });
      const code = cancelled ? "cancelled" : classified.code;
      this.#emitTerminal(
        runId,
        {
          kind: "failed",
          message: classified.message,
          data: {
            code,
            retryable: !cancelled && classified.retryable,
            ...(classified.retryAfterMs !== undefined
              ? { retryAfterMs: classified.retryAfterMs }
              : {}),
          },
        },
        cancelled ? "cancelled" : "failed",
        { failureCode: code, failureMessage: classified.message },
      );
    } finally {
      this.#controllers.delete(runId);
    }
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
