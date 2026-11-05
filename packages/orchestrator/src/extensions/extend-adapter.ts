import type { ControlMode } from "@bremio/policy";
import type {
  AgentAdapter,
  AgentRunRequest,
  McpServerManifest,
} from "@bremio/adapter-sdk";
import type { AgentEvent } from "@bremio/protocol";
import type { AgentRegistry } from "../registry";
import { mcpPolicyGate } from "./mcp-config";

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
      yield* withNotes(adapter.startRun(request), notes, req.runId);
    },
    async *resumeRun(sessionId, req) {
      const request = extendRequest(req, ext);
      const notes = await preflightNotes(adapter, ext);
      yield* withNotes(adapter.resumeRun(sessionId, request), notes, req.runId);
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
