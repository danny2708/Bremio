import { query } from "@anthropic-ai/claude-agent-sdk";
import {
  attachableMcpServers,
  checkMcpToolCall,
  describeMcpDenial,
  mcpCheckPermitsNow,
  processSupervisor,
} from "@bremio/adapter-sdk";
import type {
  CanUseTool,
  McpServerConfig,
  Options,
  PermissionMode,
  SDKMessage,
  SettingSource,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  AgentAdapter,
  AgentCapabilities,
  AgentHealth,
  AgentRunRequest,
  AgentToolVocabulary,
  AdapterRuntimeCapabilities,
  McpServerManifest,
  ModelDescriptor,
} from "@bremio/adapter-sdk";
import type { AgentEvent, RunOutcome } from "@bremio/protocol";

export interface ClaudeAdapterOptions {
  /** Override the model for every run (otherwise the SDK/CLI default is used). */
  defaultModel?: string;
}

/** File-mutating built-in tools, denied for read-only tasks. */
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

const CAPABILITIES: AgentCapabilities = {
  planning: true,
  structuredOutput: true, // native via `outputFormat: json_schema`
  repositoryRead: true,
  repositoryWrite: true,
  shell: true,
  testing: true,
  browser: false,
  vision: false,
  resumableSessions: true,
  // canUseTool denies write tools when read-only → provider-native.
  readOnlyEnforcement: "provider-native",
};

type ContentBlock = { type: string } & Record<string, unknown>;

export class ClaudeAdapter implements AgentAdapter {
  readonly id = "claude";
  readonly provider = "anthropic";

  getToolVocabulary(): AgentToolVocabulary {
    return {
      read: ["Read", "View", "Grep", "Glob"],
      write: ["Write", "Edit", "MultiEdit", "NotebookEdit"],
      shell: ["Bash"],
    };
  }

  private readonly defaultModel: string | undefined;
  private readonly controllers = new Map<string, AbortController>();
  private readonly cancelled = new Set<string>();

  constructor(options: ClaudeAdapterOptions = {}) {
    this.defaultModel = options.defaultModel;
  }

  async getCapabilities(): Promise<AgentCapabilities> {
    return CAPABILITIES;
  }

  async getRuntimeCapabilities(): Promise<AdapterRuntimeCapabilities> {
    return {
      adapterId: this.id,
      transport: "sdk",
      approval: "per-action", // canUseTool allows per-tool decisions
      structuredToolEvents: true,
      contextMetrics: "estimated",
      manualCompact: false,
      // P3-T1: manifest servers reach `query({ options.mcpServers })`, and
      // every `mcp__*` call is gated per action in `canUseTool`.
      mcp: true,
      mcpTransports: ["stdio", "sse", "streamable-http"],
      webSearch: false,
      cancellation: true,
    };
  }

  async listModels(): Promise<ModelDescriptor[]> {
    return [
      { id: "claude-opus-4-8", displayName: "Claude Opus 4.8", default: true },
      { id: "claude-sonnet-5", displayName: "Claude Sonnet 5" },
      { id: "claude-haiku-4-5", displayName: "Claude Haiku 4.5" },
    ];
  }

  async healthCheck(): Promise<AgentHealth> {
    // The SDK bundles its CLI; credentials resolve like Claude Code's. We can't
    // verify auth without a billed call, so report ok and note the assumption.
    return {
      status: "ok",
      detail: "Claude Agent SDK loaded; auth resolved at run time (API key / login).",
    };
  }

  async *startRun(req: AgentRunRequest): AsyncIterable<AgentEvent> {
    yield* this.runInternal(req);
  }

  async *resumeRun(sessionId: string, req: AgentRunRequest): AsyncIterable<AgentEvent> {
    yield* this.runInternal(req, sessionId);
  }

  private async *runInternal(req: AgentRunRequest, resumeSessionId?: string): AsyncIterable<AgentEvent> {
    const now = () => Date.now();
    yield { type: "started", runId: req.runId, ts: now() };

    const abort = new AbortController();
    this.controllers.set(req.runId, abort);
    const markSettled = processSupervisor.registerCancellable(
      req.runId,
      abort,
      `claude sdk run ${req.runId}`,
    );
    const onExternalAbort = () => abort.abort();
    req.signal?.addEventListener("abort", onExternalAbort, { once: true });
    if (req.signal?.aborted) {
      this.cancelled.add(req.runId);
      abort.abort();
    }

    const hermetic = req.role === "lead" || req.role === "planner";
    const settingSources: SettingSource[] = hermetic ? [] : ["project"];
    const permissionMode: PermissionMode = "default";

    // Events raised inside SDK callbacks, drained between streamed messages.
    const pending: AgentEvent[] = [];
    const { servers: mcpServers, skipped: skippedMcp } = toClaudeMcpServers(attachableMcpServers(req));
    for (const reason of skippedMcp) {
      pending.push({ type: "log", runId: req.runId, ts: now(), level: "warn", message: reason });
    }
    if (Object.keys(mcpServers).length > 0) {
      pending.push({
        type: "log",
        runId: req.runId,
        ts: now(),
        level: "info",
        message: `mcp servers attached: ${Object.keys(mcpServers).join(", ")}`,
      });
    }

    const canUseTool: CanUseTool = async (toolName) => {
      if (req.permission === "read-only" && WRITE_TOOLS.has(toolName)) {
        return { behavior: "deny", message: "This task is read-only; file edits are not allowed." };
      }
      // Every MCP call, Bremio-attached or from the user's own Claude config,
      // is an `mcp-tool` action under the run's control mode (docs/15 §2).
      if (toolName.startsWith("mcp__")) {
        const check = checkMcpToolCall(req, toolName);
        if (!mcpCheckPermitsNow(check)) {
          const message = describeMcpDenial(toolName, check);
          pending.push({ type: "log", runId: req.runId, ts: now(), level: "warn", message });
          return { behavior: "deny", message };
        }
      }
      return { behavior: "allow" };
    };

    const model = req.model ?? this.defaultModel;
    const options: Options = {
      cwd: req.cwd,
      abortController: abort,
      permissionMode,
      canUseTool,
      settingSources,
      systemPrompt: req.systemPrompt
        ? { type: "preset", preset: "claude_code", append: req.systemPrompt }
        : { type: "preset", preset: "claude_code" },
      ...(resumeSessionId ? { resume: resumeSessionId } : {}),
      ...(model ? { model } : {}),
      ...(req.reasoningLevel ? { effort: req.reasoningLevel } : {}),
      ...(req.maxTurns ? { maxTurns: req.maxTurns } : {}),
      ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
      ...(req.outputSchema
        ? { outputFormat: { type: "json_schema", schema: req.outputSchema } }
        : {}),
    };

    const toolNames = new Map<string, string>();
    let outcome: RunOutcome | undefined;

    try {
      for await (const msg of query({ prompt: req.prompt, options })) {
        while (pending.length > 0) yield pending.shift()!;
        if (msg.type === "result") {
          if (msg.subtype === "success") {
            yield {
              type: "usage",
              runId: req.runId,
              ts: now(),
              inputTokens: msg.usage?.input_tokens,
              outputTokens: msg.usage?.output_tokens,
              costUsd: msg.total_cost_usd,
            };
            outcome = {
              status: msg.is_error ? "failed" : "completed",
              ...(msg.result ? { finalText: msg.result } : {}),
              ...(msg.structured_output !== undefined
                ? { structured: msg.structured_output }
                : {}),
              sessionId: msg.session_id ?? resumeSessionId,
              ...(msg.is_error ? { error: "run reported is_error" } : {}),
            };
          } else {
            outcome = {
              status: "failed",
              error: msg.errors?.join("; ") || msg.subtype,
              sessionId: msg.session_id ?? resumeSessionId,
            };
          }
          continue;
        }
        yield* mapClaudeMessage(msg, req.runId, toolNames);
      }
    } catch (err) {
      const aborted =
        this.cancelled.has(req.runId) ||
        abort.signal.aborted ||
        (err as Error).name === "AbortError";
      outcome = aborted
        ? { status: "cancelled" }
        : { status: "failed", error: (err as Error).message, sessionId: resumeSessionId };
    } finally {
      req.signal?.removeEventListener("abort", onExternalAbort);
      this.controllers.delete(req.runId);
      markSettled();
    }

    while (pending.length > 0) yield pending.shift()!;
    const wasCancelled = this.cancelled.delete(req.runId);
    if (!outcome) {
      outcome = wasCancelled
        ? { status: "cancelled" }
        : { status: "failed", error: "run ended without a result", sessionId: resumeSessionId };
    } else if (wasCancelled && outcome.status !== "completed") {
      outcome = { ...outcome, status: "cancelled" };
    }

    yield { type: "completed", runId: req.runId, ts: now(), outcome };
  }

  /**
   * Cooperative cancellation only.
   *
   * The Agent SDK runs in-process and owns no child process, so aborting is
   * the entire mechanism — there is nothing to signal and nothing to kill. The
   * supervisor therefore waits for the SDK call to actually settle before
   * calling this stopped. An SDK that ignored its AbortSignal would still be
   * running, and reporting success there would be indistinguishable from a
   * real cancellation.
   */
  async cancelRun(runId: string): Promise<void> {
    const controller = this.controllers.get(runId);
    if (!controller) return;
    this.cancelled.add(runId);
    controller.abort();
    const outcome = await processSupervisor.terminate(runId);
    if (!outcome.stopped) {
      throw new Error(`could not stop the Claude run ${runId}: ${outcome.reason}`);
    }
  }
}

/**
 * Translate Bremio MCP manifests into Agent SDK `mcpServers`. A stdio server
 * with a `cwd` is skipped with a named reason: the SDK's stdio config has no
 * working-directory field, and starting it elsewhere would be a different
 * server than the one the user configured.
 */
export function toClaudeMcpServers(manifests: readonly McpServerManifest[]): {
  servers: Record<string, McpServerConfig>;
  skipped: string[];
} {
  const servers: Record<string, McpServerConfig> = {};
  const skipped: string[] = [];
  for (const m of manifests) {
    const t = m.transport;
    if (t.type === "stdio") {
      if (t.cwd) {
        skipped.push(`mcp server "${m.id}" not attached: Claude cannot start a stdio server in a custom cwd`);
        continue;
      }
      // Passthrough names resolve here, in-process: the SDK config is an
      // object, never argv, so a resolved secret is not exposed.
      const inherited: Record<string, string> = {};
      for (const name of t.envPassthrough ?? []) {
        const value = process.env[name];
        if (value !== undefined) inherited[name] = value;
      }
      const env = { ...inherited, ...(t.env ?? {}) };
      servers[m.id] = {
        type: "stdio",
        command: t.command,
        args: [...t.args],
        ...(Object.keys(env).length > 0 ? { env } : {}),
      };
    } else if (t.type === "sse") {
      servers[m.id] = { type: "sse", url: t.url };
    } else {
      servers[m.id] = { type: "http", url: t.url };
    }
  }
  return { servers, skipped };
}

/** Map a non-terminal SDKMessage to normalized AgentEvent(s). */
function* mapClaudeMessage(
  msg: SDKMessage,
  runId: string,
  toolNames: Map<string, string>,
): Generator<AgentEvent> {
  const ts = Date.now();

  if (msg.type === "system") {
    const model = "model" in msg ? String((msg as { model?: unknown }).model ?? "") : "";
    yield {
      type: "log",
      runId,
      ts,
      level: "info",
      message: `session init${model ? ` model=${model}` : ""}`,
    };
    if (model) yield { type: "usage", runId, ts, model };
    return;
  }

  if (msg.type === "assistant") {
    const blocks = (msg.message?.content ?? []) as unknown as ContentBlock[];
    for (const block of blocks) {
      if (block.type === "text" && typeof block.text === "string") {
        yield { type: "message", runId, ts, role: "assistant", text: block.text };
      } else if (block.type === "thinking" && typeof block.thinking === "string") {
        yield { type: "thinking", runId, ts, text: block.thinking };
      } else if (block.type === "tool_use") {
        const name = String(block.name ?? "tool");
        if (typeof block.id === "string") toolNames.set(block.id, name);
        yield {
          type: "tool_use",
          runId,
          ts,
          name,
          ...(block.input !== undefined ? { input: block.input } : {}),
        };
      }
    }
    return;
  }

  if (msg.type === "user") {
    const blocks = (msg.message?.content ?? []) as unknown as ContentBlock[];
    if (!Array.isArray(blocks)) return;
    for (const block of blocks) {
      if (block.type === "tool_result") {
        const id = typeof block.tool_use_id === "string" ? block.tool_use_id : "";
        const name = toolNames.get(id) ?? "tool";
        const ok = block.is_error !== true;
        yield {
          type: "tool_result",
          runId,
          ts,
          name,
          ok,
          ...(coerceText(block.content) ? { detail: coerceText(block.content) } : {}),
        };
      }
    }
  }
}

function coerceText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = content
      .map((c) =>
        c && typeof c === "object" && "text" in c
          ? String((c as { text: unknown }).text)
          : "",
      )
      .filter(Boolean);
    return parts.length ? parts.join(" ") : undefined;
  }
  return undefined;
}
