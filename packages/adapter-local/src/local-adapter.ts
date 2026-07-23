import { classifyAgentError } from "@bremio/adapter-sdk";
import type {
  AgentAdapter,
  AgentCapabilities,
  AgentHealth,
  AgentRunRequest,
  ModelDescriptor,
} from "@bremio/adapter-sdk";
import type { AgentEvent } from "@bremio/protocol";
import { CONSERVATIVE_CAPABILITIES, type LocalProviderConfig } from "./config";

const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * A generic adapter for any local server that speaks the OpenAI-compatible
 * `/v1/chat/completions` API. This is the reusable plumbing — transport,
 * streaming, cancellation, health — so integrating a specific local model is
 * "describe it with a `LocalProviderConfig`, decide its capabilities, register
 * it" rather than writing an adapter from scratch. See `docs/11`.
 *
 * It deliberately makes no assumption about tools: a plain chat endpoint emits
 * text and nothing else, which is why the default capabilities are all `false`.
 * An integration that wraps the model in an agentic harness turns the relevant
 * capabilities on through the config — the adapter does not need to change.
 */
export class LocalOpenAiAdapter implements AgentAdapter {
  readonly id: string;
  readonly provider = "local";

  readonly #config: LocalProviderConfig;
  readonly #capabilities: AgentCapabilities;
  readonly #controllers = new Map<string, AbortController>();

  constructor(config: LocalProviderConfig) {
    this.id = config.id;
    this.#config = config;
    this.#capabilities = { ...CONSERVATIVE_CAPABILITIES, ...config.capabilities };
  }

  async getCapabilities(): Promise<AgentCapabilities> {
    return this.#capabilities;
  }

  async listModels(): Promise<ModelDescriptor[]> {
    try {
      const res = await fetch(`${this.#baseUrl()}/models`, { headers: this.#headers() });
      if (!res.ok) return [];
      const body = (await res.json()) as { data?: Array<{ id?: unknown }> };
      return (body.data ?? [])
        .map((entry) => entry.id)
        .filter((id): id is string => typeof id === "string" && id.length > 0)
        .map((id) => ({ id }));
    } catch {
      return [];
    }
  }

  async healthCheck(): Promise<AgentHealth> {
    const base = this.#baseUrl();
    const path = this.#config.healthPath ?? "/models";
    try {
      const res = await fetch(`${base}${path}`, {
        headers: this.#headers(),
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) {
        return { status: "degraded", detail: `${this.id} at ${base} responded ${res.status}` };
      }
      // Reachable — but a server with no model loaded cannot actually run.
      if (!this.#config.model) {
        const models = await this.listModels();
        if (models.length === 0) {
          return {
            status: "degraded",
            detail: `${this.id} reachable at ${base} but no model is loaded; load one or set config.model`,
          };
        }
      }
      return { status: "ok", detail: `${this.id} ready at ${base}` };
    } catch (err) {
      return {
        status: "unavailable",
        detail: `${this.id} not reachable at ${base}: ${(err as Error).message}`,
      };
    }
  }

  async *startRun(req: AgentRunRequest): AsyncIterable<AgentEvent> {
    const now = (): number => Date.now();
    yield { type: "started", runId: req.runId, ts: now() };

    const controller = new AbortController();
    this.#controllers.set(req.runId, controller);
    const onAbort = (): void => controller.abort();
    req.signal?.addEventListener("abort", onAbort, { once: true });
    if (req.signal?.aborted) controller.abort();

    const timeout = setTimeout(() => controller.abort(), this.#config.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    try {
      const model = req.model || this.#config.model || (await this.listModels())[0]?.id;
      if (!model) {
        yield this.#failed(req, `no model specified and none discoverable at ${this.#baseUrl()}`);
        return;
      }

      const messages = [
        ...(req.systemPrompt ? [{ role: "system", content: req.systemPrompt }] : []),
        { role: "user", content: req.prompt },
      ];

      const res = await fetch(`${this.#baseUrl()}/chat/completions`, {
        method: "POST",
        headers: this.#headers(),
        body: JSON.stringify({ model, messages, stream: true }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        const detail = await res.text().catch(() => "");
        throw new Error(`chat/completions ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`);
      }

      let finalText = "";
      let usage: { inputTokens?: number; outputTokens?: number } | undefined;

      for await (const data of parseSse(res.body)) {
        if (data === "[DONE]") break;
        let json: ChatChunk;
        try {
          json = JSON.parse(data) as ChatChunk;
        } catch {
          continue; // keep-alive comment or a partial line; ignore
        }
        const delta = json.choices?.[0]?.delta?.content;
        if (typeof delta === "string" && delta.length > 0) {
          finalText += delta;
          yield { type: "message", runId: req.runId, ts: now(), role: "assistant", text: delta };
        }
        if (json.usage) {
          usage = {
            ...(typeof json.usage.prompt_tokens === "number" ? { inputTokens: json.usage.prompt_tokens } : {}),
            ...(typeof json.usage.completion_tokens === "number" ? { outputTokens: json.usage.completion_tokens } : {}),
          };
        }
      }

      if (usage) {
        yield { type: "usage", runId: req.runId, ts: now(), model, ...usage };
      }

      yield {
        type: "completed",
        runId: req.runId,
        ts: now(),
        outcome: {
          status: controller.signal.aborted ? "cancelled" : "completed",
          ...(finalText ? { finalText } : {}),
        },
      };
    } catch (err) {
      if (controller.signal.aborted) {
        yield {
          type: "completed",
          runId: req.runId,
          ts: now(),
          outcome: { status: "cancelled", error: "run cancelled" },
        };
      } else {
        const classified = classifyAgentError(err, { provider: this.id });
        yield this.#failed(req, classified.message);
      }
    } finally {
      clearTimeout(timeout);
      req.signal?.removeEventListener("abort", onAbort);
      this.#controllers.delete(req.runId);
    }
  }

  resumeRun(_sessionId: string, _request: AgentRunRequest): AsyncIterable<AgentEvent> {
    throw new Error(`${this.id} resumeRun is not implemented (resumableSessions: false)`);
  }

  async cancelRun(runId: string): Promise<void> {
    this.#controllers.get(runId)?.abort();
  }

  #failed(req: AgentRunRequest, error: string): AgentEvent {
    return {
      type: "completed",
      runId: req.runId,
      ts: Date.now(),
      outcome: { status: "failed", error: `${this.id}: ${error}` },
    };
  }

  #baseUrl(): string {
    const override = this.#config.baseUrlEnvVar ? process.env[this.#config.baseUrlEnvVar] : undefined;
    return (override || this.#config.baseUrl).replace(/\/+$/, "");
  }

  #headers(): Record<string, string> {
    const key = this.#config.apiKeyEnvVar ? process.env[this.#config.apiKeyEnvVar] : undefined;
    return { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) };
  }
}

interface ChatChunk {
  choices?: Array<{ delta?: { content?: unknown } }>;
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
}

/**
 * Yield each `data:` payload from an OpenAI-style SSE body. Frames are split on
 * newlines and the `data:` prefix stripped; the caller handles `[DONE]` and JSON
 * parsing. Keeps a buffer so a chunk that splits a line mid-frame still parses.
 */
export async function* parseSse(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line.startsWith("data:")) yield line.slice(5).trim();
      }
    }
  } finally {
    reader.releaseLock();
  }
}
