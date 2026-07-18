import {
  createRegistry,
  runBremio,
  runSingleAgent,
  type BremioRunReport,
} from "@bremio/orchestrator";
import type { ReasoningLevel } from "@bremio/protocol";
import { AntigravityAdapter } from "@bremio/adapter-antigravity";
import { ClaudeAdapter } from "@bremio/adapter-claude";
import { CodexAdapter } from "@bremio/adapter-codex";

export type RunState = "running" | "completed" | "failed" | "cancelled";

/**
 * One entry in a run's event log. `seq` lets a client that reconnects ask for
 * everything after what it already has, so a dropped stream never loses events.
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
    | "failed";
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
}

export interface DaemonRun {
  id: string;
  mode: "single" | "team";
  repoPath: string;
  prompt: string;
  agentId: string;
  state: RunState;
  startedAt: number;
  finishedAt?: number;
  events: RunEvent[];
  report?: BremioRunReport;
  error?: string;
}

type Listener = (event: RunEvent) => void;

/**
 * Holds live runs and their event history in memory.
 *
 * Buffering matters: a UI that attaches after a run started still needs the
 * backlog, and one that reconnects must not silently lose the events it missed.
 * Finished runs stay until evicted so a client can read the outcome it was
 * waiting for; the on-disk report remains the durable record.
 */
export class RunRegistry {
  readonly #runs = new Map<string, DaemonRun>();
  readonly #controllers = new Map<string, AbortController>();
  readonly #listeners = new Map<string, Set<Listener>>();
  #counter = 0;

  constructor(private readonly maxRetained = 50) {}

  list(): DaemonRun[] {
    return [...this.#runs.values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  get(id: string): DaemonRun | undefined {
    return this.#runs.get(id);
  }

  /** Replay from `afterSeq`, then receive live events. Returns an unsubscribe. */
  subscribe(id: string, listener: Listener, afterSeq = 0): () => void {
    const run = this.#runs.get(id);
    if (!run) throw new Error(`unknown run: ${id}`);
    for (const event of run.events) {
      if (event.seq > afterSeq) listener(event);
    }
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

  start(input: StartRunInput): DaemonRun {
    // A local handle id, distinct from the orchestrator's on-disk run id: the
    // client needs something to subscribe to before the run has produced one.
    const id = `d-${Date.now().toString(36)}-${(this.#counter += 1).toString(36)}`;
    const run: DaemonRun = {
      id,
      mode: input.mode,
      repoPath: input.repoPath,
      prompt: input.prompt,
      agentId: input.agentId,
      state: "running",
      startedAt: Date.now(),
      events: [],
    };
    this.#runs.set(id, run);
    this.#evict();

    const controller = new AbortController();
    this.#controllers.set(id, controller);
    void this.#execute(run, input, controller);
    return run;
  }

  #emit(run: DaemonRun, event: Omit<RunEvent, "seq" | "ts">): void {
    const full: RunEvent = { ...event, seq: run.events.length + 1, ts: Date.now() };
    run.events.push(full);
    for (const listener of this.#listeners.get(run.id) ?? []) {
      try {
        listener(full);
      } catch {
        // one broken subscriber must not stop the others or the run
      }
    }
  }

  async #execute(
    run: DaemonRun,
    input: StartRunInput,
    controller: AbortController,
  ): Promise<void> {
    const registry = createRegistry([
      new ClaudeAdapter(),
      new CodexAdapter(),
      new AntigravityAdapter(),
    ]);

    try {
      const report = input.mode === "single"
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
              onStart: (id) => this.#emit(run, { kind: "status", message: `${id} started`, agentId: id }),
              onEvent: (event) =>
                this.#emit(run, { kind: "task-event", message: describe(event), data: event }),
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
                this.#emit(run, { kind: "lead", message: `lead ${id} planning`, agentId: id }),
              onLeadEvent: (event) =>
                this.#emit(run, { kind: "lead", message: describe(event), data: event }),
              onPlan: (plan, assign) =>
                this.#emit(run, {
                  kind: "plan",
                  message: plan.summary,
                  data: { plan, assign: Object.fromEntries(assign) },
                }),
              onTaskStart: (task, agentId) =>
                this.#emit(run, {
                  kind: "task-start",
                  message: task.title,
                  taskId: task.id,
                  agentId,
                }),
              onEvent: (task, agentId, event) =>
                this.#emit(run, {
                  kind: "task-event",
                  message: describe(event),
                  taskId: task.id,
                  agentId,
                  data: event,
                }),
              onTaskComplete: (result) =>
                this.#emit(run, {
                  kind: "task-complete",
                  message: result.status,
                  taskId: result.taskId,
                  agentId: result.agentId,
                  data: result,
                }),
            },
          });

      run.report = report;
      run.state = controller.signal.aborted ? "cancelled" : "completed";
      run.finishedAt = Date.now();
      this.#emit(run, { kind: "finished", message: run.state, data: report });
    } catch (err) {
      run.state = controller.signal.aborted ? "cancelled" : "failed";
      run.error = (err as Error).message;
      run.finishedAt = Date.now();
      this.#emit(run, { kind: "failed", message: run.error });
    } finally {
      this.#controllers.delete(run.id);
    }
  }

  /** Drop the oldest finished runs; live runs are never evicted. */
  #evict(): void {
    const finished = [...this.#runs.values()]
      .filter((run) => run.state !== "running")
      .sort((a, b) => a.startedAt - b.startedAt);
    let excess = this.#runs.size - this.maxRetained;
    for (const run of finished) {
      if (excess <= 0) break;
      this.#runs.delete(run.id);
      this.#listeners.delete(run.id);
      excess -= 1;
    }
  }
}

function describe(event: { type: string; [key: string]: unknown }): string {
  if (event.type === "message" && typeof event.text === "string") {
    return event.text.split("\n")[0]?.slice(0, 200) ?? "";
  }
  if (event.type === "tool_use" && typeof event.name === "string") return `tool: ${event.name}`;
  if (event.type === "completed") return "completed";
  return event.type;
}
