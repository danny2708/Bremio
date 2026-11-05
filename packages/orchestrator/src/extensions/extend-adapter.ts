import type { ControlMode } from "@bremio/policy";
import type {
  AgentAdapter,
  AgentRunRequest,
  HookManager,
  HookPoint,
  McpServerManifest,
} from "@bremio/adapter-sdk";
import type { AgentEvent } from "@bremio/protocol";
import type { AgentRegistry } from "../registry";
import { mcpPolicyGate } from "./mcp-config";
import { describeHookVeto } from "./hooks-config";

/**
 * Per-run additions Bremio makes to every adapter call (docs/17 P3).
 *
 * Applied by wrapping the registry once per run rather than threading new
 * options through the lead manager, scheduler and single runner: every path
 * that reaches an adapter — planning, plan repair, tasks, fixes, resumes —
 * passes through `startRun`/`resumeRun`, so this is the one place that cannot
 * be bypassed by a new call site.
 */
export interface RunExtensions {
  /** The run's control mode; it becomes the MCP policy gate on every request. */
  controlMode: ControlMode;
  /** MCP servers the run opted into (already validated and selected). */
  mcpServers?: readonly McpServerManifest[];
  /**
   * Lifecycle hooks (P3-T2). `run:pre-plan` runs before a lead/planner call,
   * `run:pre-task` before any other agent call, `run:post-task` after a
   * non-lead call that completed. A veto stops the call with a named reason.
   */
  hooks?: HookManager;
  /** Repository root, passed to hooks as context. */
  repoPath?: string;
}

/** Notes raised before the adapter's own events, emitted as `log` events. */
type Note = { level: "info" | "warn"; message: string };

async function preflightNotes(adapter: AgentAdapter, ext: RunExtensions): Promise<Note[]> {
  const notes: Note[] = [];
  const servers = ext.mcpServers ?? [];
  if (servers.length > 0) {
    const caps = await adapter.getRuntimeCapabilities().catch(() => undefined);
    if (!caps?.mcp) {
      notes.push({
        level: "warn",
        message: `mcp servers requested (${servers.map((s) => s.id).join(", ")}) but ${adapter.id} cannot attach MCP servers; this agent runs without them`,
      });
    } else {
      const supported = new Set(caps.mcpTransports ?? []);
      for (const s of servers) {
        if (!supported.has(s.transport.type)) {
          notes.push({
            level: "warn",
            message: `mcp server "${s.id}" uses ${s.transport.type}, which ${adapter.id} cannot attach`,
          });
        }
      }
    }
  }
  return notes;
}

function extendRequest(req: AgentRunRequest, ext: RunExtensions): AgentRunRequest {
  return {
    ...req,
    mcpToolGate: mcpPolicyGate(ext.controlMode),
    ...(ext.mcpServers && ext.mcpServers.length > 0 ? { mcpServers: ext.mcpServers } : {}),
  };
}

async function* withNotes(
  inner: AsyncIterable<AgentEvent>,
  notes: Note[],
  runId: string,
): AsyncIterable<AgentEvent> {
  let pending = notes.length > 0;
  for await (const event of inner) {
    yield event;
    // After the adapter's own `started`, so consumers that expect `started`
    // first still see it first.
    if (pending) {
      pending = false;
      for (const n of notes) {
        yield { type: "log", runId, ts: Date.now(), level: n.level, message: n.message };
      }
    }
  }
}

const PLANNING_ROLES = new Set(["lead", "planner"]);

function hookContext(adapter: AgentAdapter, req: AgentRunRequest, ext: RunExtensions) {
  return {
    runId: req.runId,
    agentId: adapter.id,
    role: req.role,
    permission: req.permission,
    cwd: req.cwd,
    prompt: req.prompt,
    ...(ext.repoPath ? { repoPath: ext.repoPath } : {}),
  };
}

/**
 * Run the agent call between its lifecycle hooks. A pre-hook veto never
 * reaches the provider: the call reports `started`, the veto, and a failed
 * `completed`, so every consumer sees a normal (failed) agent run. A
 * post-task veto rewrites a completed outcome as failed — the work is left
 * where the agent put it, but nothing downstream may treat it as done.
 */
async function* withHooks(
  adapter: AgentAdapter,
  req: AgentRunRequest,
  ext: RunExtensions,
  call: () => AsyncIterable<AgentEvent>,
): AsyncIterable<AgentEvent> {
  const hooks = ext.hooks;
  if (!hooks) {
    yield* call();
    return;
  }
  const planning = PLANNING_ROLES.has(req.role);
  const pre: HookPoint = planning ? "run:pre-plan" : "run:pre-task";
  const context = hookContext(adapter, req, ext);
  const preResult = await hooks.evaluate(pre, { ...context, hookPoint: pre });
  if (!preResult.allowed) {
    const message = describeHookVeto(pre, preResult);
    yield { type: "started", runId: req.runId, ts: Date.now() };
    yield { type: "log", runId: req.runId, ts: Date.now(), level: "warn", message };
    yield {
      type: "completed",
      runId: req.runId,
      ts: Date.now(),
      outcome: { status: "failed", error: message },
    };
    return;
  }
  for await (const event of call()) {
    if (event.type === "completed" && !planning && event.outcome.status === "completed") {
      const post = await hooks.evaluate("run:post-task", {
        ...context,
        hookPoint: "run:post-task",
        outcome: { status: event.outcome.status },
      });
      if (!post.allowed) {
        const message = describeHookVeto("run:post-task", post);
        yield { type: "log", runId: req.runId, ts: Date.now(), level: "warn", message };
        yield { ...event, outcome: { ...event.outcome, status: "failed", error: message } };
        continue;
      }
    }
    yield event;
  }
}

/** Wrap one adapter so every request carries the run's extensions. */
export function extendAdapter(adapter: AgentAdapter, ext: RunExtensions): AgentAdapter {
  const wrapped: AgentAdapter = {
    id: adapter.id,
    provider: adapter.provider,
    healthCheck: () => adapter.healthCheck(),
    getCapabilities: () => adapter.getCapabilities(),
    getRuntimeCapabilities: () => adapter.getRuntimeCapabilities(),
    listModels: () => adapter.listModels(),
    ...(adapter.getToolVocabulary
      ? { getToolVocabulary: () => adapter.getToolVocabulary!() }
      : {}),
    async *startRun(req) {
      const request = extendRequest(req, ext);
      const notes = await preflightNotes(adapter, ext);
      yield* withHooks(adapter, request, ext, () =>
        withNotes(adapter.startRun(request), notes, req.runId),
      );
    },
    async *resumeRun(sessionId, req) {
      const request = extendRequest(req, ext);
      const notes = await preflightNotes(adapter, ext);
      yield* withHooks(adapter, request, ext, () =>
        withNotes(adapter.resumeRun(sessionId, request), notes, req.runId),
      );
    },
    cancelRun: (runId) => adapter.cancelRun(runId),
  };
  return wrapped;
}

/** Wrap every adapter in a registry. Ids and iteration order are preserved. */
export function extendRegistry(registry: AgentRegistry, ext: RunExtensions): AgentRegistry {
  const out: AgentRegistry = new Map();
  for (const [id, adapter] of registry) out.set(id, extendAdapter(adapter, ext));
  return out;
}
