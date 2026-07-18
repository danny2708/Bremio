import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  CanUseTool,
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
};

type ContentBlock = { type: string } & Record<string, unknown>;

export class ClaudeAdapter implements AgentAdapter {
  readonly id = "claude";
  readonly provider = "anthropic";

  private readonly defaultModel: string | undefined;
  private readonly controllers = new Map<string, AbortController>();
  private readonly cancelled = new Set<string>();

  constructor(options: ClaudeAdapterOptions = {}) {
    this.defaultModel = options.defaultModel;
  }

  async getCapabilities(): Promise<AgentCapabilities> {
    return CAPABILITIES;
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
    const now = () => Date.now();
    yield { type: "started", runId: req.runId, ts: now() };

    const abort = new AbortController();
    this.controllers.set(req.runId, abort);
    const onExternalAbort = () => abort.abort();
    req.signal?.addEventListener("abort", onExternalAbort, { once: true });
    // A signal already aborted before we attached the listener won't fire it.
    if (req.signal?.aborted) {
      this.cancelled.add(req.runId);
      abort.abort();
    }

    const hermetic = req.role === "lead" || req.role === "planner";
    const settingSources: SettingSource[] = hermetic ? [] : ["project"];
    const permissionMode: PermissionMode = "default";

    const canUseTool: CanUseTool = async (toolName) => {
      if (req.permission === "read-only" && WRITE_TOOLS.has(toolName)) {
        return { behavior: "deny", message: "This task is read-only; file edits are not allowed." };
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
      ...(model ? { model } : {}),
      ...(req.maxTurns ? { maxTurns: req.maxTurns } : {}),
      ...(req.outputSchema
        ? { outputFormat: { type: "json_schema", schema: req.outputSchema } }
        : {}),
    };

    const toolNames = new Map<string, string>();
    let outcome: RunOutcome | undefined;

    try {
      for await (const msg of query({ prompt: req.prompt, options })) {
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
              sessionId: msg.session_id,
              ...(msg.is_error ? { error: "run reported is_error" } : {}),
            };
          } else {
            outcome = {
              status: "failed",
              error: msg.errors?.join("; ") || msg.subtype,
              sessionId: msg.session_id,
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
        : { status: "failed", error: (err as Error).message };
    } finally {
      req.signal?.removeEventListener("abort", onExternalAbort);
      this.controllers.delete(req.runId);
    }

    const wasCancelled = this.cancelled.delete(req.runId);
    if (!outcome) {
      outcome = wasCancelled
        ? { status: "cancelled" }
        : { status: "failed", error: "run ended without a result" };
    } else if (wasCancelled && outcome.status !== "completed") {
      outcome = { ...outcome, status: "cancelled" };
    }

    yield { type: "completed", runId: req.runId, ts: now(), outcome };
  }

  resumeRun(): AsyncIterable<AgentEvent> {
    throw new Error("resumeRun is not implemented in Phase 1");
  }

  async cancelRun(runId: string): Promise<void> {
    const controller = this.controllers.get(runId);
    if (!controller) return;
    this.cancelled.add(runId);
    controller.abort();
  }
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
