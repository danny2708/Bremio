import { randomBytes } from "node:crypto";
import { createServer, type AddressInfo } from "node:net";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { processSupervisor, classifyAgentError } from "@bremio/adapter-sdk";
import type {
  AgentAdapter,
  AgentCapabilities,
  AgentHealth,
  AgentRunRequest,
  ModelDescriptor,
} from "@bremio/adapter-sdk";
import type { AgentEvent } from "@bremio/protocol";
import { mapOpenCodeLine } from "./events";
import { resolveOpenCodeBinary, spawnOpenCode } from "./binary";

export function parseServerResponse(result: { parts?: Array<{ type: string; text?: string }> }): string {
  const textPart = result.parts?.find((p) => p.type === "text");
  return textPart?.text ?? "";
}

// parseServerResponse accepts the narrower type; this helper bridges the
// Record<string,unknown>[] returned by sendPrompt into the expected shape.
export function parseACPResponse(raw: { parts?: Array<Record<string, unknown>> }): string {
  return parseServerResponse(raw as { parts?: Array<{ type: string; text?: string }> });
}

export function validateStructuredOutput(
  text: string,
): { valid: true; data: unknown } | { valid: false; error: string } {
  // Strip markdown code fences and extract first JSON object from surrounding
  // prose (models often prefix with "Here is my plan:" etc.). Matches the
  // approach used by lead-manager.ts extractJsonObject.
  const unfenced = text.replace(/```(?:json)?/gi, "").trim();
  const start = unfenced.indexOf("{");
  const jsonStr = start >= 0 ? unfenced.slice(start) : unfenced;
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    return { valid: false, error: "output is not valid JSON" };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { valid: false, error: "output must be a JSON object, not an array or primitive" };
  }
  return { valid: true, data: parsed };
}

export interface OpenCodeAdapterOptions {
  explicitBin?: string;
  extraArgs?: string[];
  defaultTimeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10 * 60_000;

const CAPABILITIES: AgentCapabilities = {
  planning: true,
  structuredOutput: true,
  repositoryRead: true,
  repositoryWrite: true,
  shell: true,
  testing: true,
  browser: false,
  vision: false,
  resumableSessions: false,
};

export class OpenCodeAdapter implements AgentAdapter {
  readonly id = "opencode";
  readonly provider = "opencode";

  private readonly explicitBin: string | undefined;
  private readonly extraArgs: string[];
  private readonly defaultTimeoutMs: number;
  private readonly children = new Map<string, ReturnType<typeof spawnOpenCode>>();
  private readonly cancelled = new Set<string>();
  private readonly servers = new Map<
    string,
    { serverUrl: string; sessionId?: string; cleanup: () => Promise<void> }
  >();

  constructor(options: OpenCodeAdapterOptions = {}) {
    this.explicitBin = options.explicitBin;
    this.extraArgs = options.extraArgs ?? [];
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async getCapabilities(): Promise<AgentCapabilities> {
    return CAPABILITIES;
  }

  /**
   * OpenCode is a multi-provider front end: `--model` takes `provider/model`,
   * and which models exist depends entirely on the user's configured
   * credentials. `build` and `plan` are *agents* (permission profiles), not
   * models, so listing them here would hand the router an id that `--model`
   * cannot accept. Reporting nothing is the honest answer until the configured
   * model list is read from the provider — omitting `--model` then leaves the
   * user's own default in place, which is what every other adapter does.
   */
  async listModels(): Promise<ModelDescriptor[]> {
    return [];
  }

  async healthCheck(): Promise<AgentHealth> {
    const bin = resolveOpenCodeBinary(this.explicitBin);
    if (!bin) {
      return { status: "unavailable", detail: "opencode CLI not found; install with: npm install -g opencode-ai" };
    }

    const version = await this.readVersion(bin);
    if (!version) {
      return { status: "unavailable", detail: `opencode at ${bin} did not report a version` };
    }

    const authOk = await this.checkAuth(bin);
    if (!authOk) {
      return {
        status: "degraded",
        detail: `opencode ${version}; no provider credentials configured; run 'opencode providers login'`,
      };
    }

    return { status: "ok", detail: `opencode ${version}; providers configured` };
  }

  async *startRun(req: AgentRunRequest): AsyncIterable<AgentEvent> {
    const now = () => Date.now();
    yield { type: "started", runId: req.runId, ts: now() };

    const bin = resolveOpenCodeBinary(this.explicitBin);
    if (!bin) {
      yield {
        type: "completed",
        runId: req.runId,
        ts: now(),
        outcome: { status: "failed", error: "opencode CLI not found; install with: npm install -g opencode-ai" },
      };
      return;
    }

    if (req.outputSchema) {
      yield* this.startServerRun(req, bin);
    } else {
      yield* this.startCliRun(req, bin);
    }
  }

  private async *startCliRun(req: AgentRunRequest, bin: string): AsyncIterable<AgentEvent> {
    const now = () => Date.now();

    const args = [...this.extraArgs, "run", "--format", "json", "--dir", path.resolve(req.cwd), "--auto"];

    if (req.model) args.push("--model", req.model);
    if (req.reasoningLevel) args.push("--variant", req.reasoningLevel);

    const readOnly = req.permission === "read-only";
    if (readOnly) args.push("--agent", "plan");

    // Passed as a single argv entry with shell:false, so newlines survive and no
    // quoting is involved. Collapsing them would flatten every structured task
    // prompt — acceptance criteria, file lists, the review JSON template — into
    // one unreadable line before the model ever sees it.
    const prompt = req.systemPrompt
      ? `${req.systemPrompt}\n\n${req.prompt}`
      : req.prompt;

    args.push(prompt);

    let spawnError: Error | undefined;
    let stderr = "";
    const child = spawnOpenCode(bin, args, req.cwd);
    this.children.set(req.runId, child);
    processSupervisor.adopt(req.runId, child);

    child.on("error", (e) => {
      spawnError = e;
    });
    child.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    const onAbort = () => void this.cancelRun(req.runId);
    req.signal?.addEventListener("abort", onAbort, { once: true });
    if (req.signal?.aborted) void this.cancelRun(req.runId);

    const exit = new Promise<number | null>((resolve) => {
      child.on("close", (code) => resolve(code));
    });

    let finalText = "";
    const rl = readline.createInterface({ input: child.stdout!, crlfDelay: Infinity });
    try {
      for await (const line of rl) {
        for (const ev of mapOpenCodeLine(line, req.runId)) {
          if (ev.type === "message") finalText += ev.text + "\n";
          yield ev;
        }
      }
    } finally {
      rl.close();
      req.signal?.removeEventListener("abort", onAbort);
    }

    const code = await exit;
    this.children.delete(req.runId);

    if (stderr.trim()) {
      yield {
        type: "log",
        runId: req.runId,
        ts: now(),
        level: code === 0 ? "debug" : "warn",
        message: `opencode stderr: ${stderr.trim().slice(-2000)}`,
      };
    }

    const wasCancelled = this.cancelled.delete(req.runId);
    const status = wasCancelled ? "cancelled" : code === 0 ? "completed" : "failed";
    const trimmed = finalText.trim();
    const error =
      status === "failed"
        ? spawnError
          ? spawnError.message
          : `opencode exited with code ${code}${stderr ? `: ${stderr.trim().slice(-500)}` : ""}`
        : undefined;

    yield {
      type: "completed",
      runId: req.runId,
      ts: now(),
      outcome: {
        status,
        ...(trimmed ? { finalText: trimmed } : {}),
        ...(error ? { error } : {}),
      },
    };
  }

  private async *startServerRun(req: AgentRunRequest, bin: string): AsyncIterable<AgentEvent> {
    const now = () => Date.now();

    const port = await findFreePort();
    const serverUrl = `http://127.0.0.1:${port}`;

    const child = spawnOpenCode(bin, [...this.extraArgs, "serve", "--port", String(port)], req.cwd);
    this.children.set(req.runId, child);
    processSupervisor.adopt(req.runId, child);

    this.servers.set(req.runId, {
      serverUrl,
      cleanup: async () => {
        child.kill();
        this.children.delete(req.runId);
      },
    });

    child.stderr?.on("data", () => {});

    try {
      await waitForServer(serverUrl, 15_000);

      const session = await createSession(serverUrl, { title: `bremio-${req.runId}` });
      const sessionId = session.id;
      // The abort endpoint is keyed by the server's session id, not the run id.
      // Recording it here is what makes cancellation a graceful abort instead of
      // a 404 that silently degrades into killing the whole server.
      const server = this.servers.get(req.runId);
      if (server) server.sessionId = sessionId;

      const onAbort = () => void this.cancelRun(req.runId);
      req.signal?.addEventListener("abort", onAbort, { once: true });
      if (req.signal?.aborted) void this.cancelRun(req.runId);

      const promptBody: Record<string, unknown> = {
        parts: [{ type: "text", text: req.prompt }],
      };
      if (req.model) {
        const [providerID, ...modelParts] = req.model.split("/");
        promptBody.model = { providerID, modelID: modelParts.join("/") };
      }
      if (req.systemPrompt) {
        promptBody.system = req.systemPrompt;
      }

      const result = await sendPrompt(serverUrl, sessionId, promptBody);

      await this.servers.get(req.runId)?.cleanup();
      this.servers.delete(req.runId);

      let finalText = parseACPResponse(result);

      if (req.outputSchema && finalText) {
        const validation = validateStructuredOutput(finalText);
        if (!validation.valid) {
          yield {
            type: "completed",
            runId: req.runId,
            ts: now(),
            outcome: { status: "failed", error: validation.error },
          };
          return;
        }
        finalText = JSON.stringify(validation.data);
      }

      const wasCancelled = this.cancelled.delete(req.runId);
      yield {
        type: "completed",
        runId: req.runId,
        ts: now(),
        outcome: {
          status: wasCancelled ? "cancelled" : "completed",
          ...(finalText ? { finalText } : {}),
        },
      };
    } catch (err) {
      await this.servers.get(req.runId)?.cleanup().catch(() => {});
      this.servers.delete(req.runId);

      const classified = classifyAgentError(err, { provider: "opencode" });
      yield {
        type: "completed",
        runId: req.runId,
        ts: now(),
        outcome: {
          status: "failed",
          error: classified.message,
        },
      };
    }
  }

  resumeRun(): AsyncIterable<AgentEvent> {
    throw new Error("OpenCode resumeRun is not implemented (resumableSessions: false)");
  }

  async cancelRun(runId: string): Promise<void> {
    const server = this.servers.get(runId);
    if (server) {
      this.cancelled.add(runId);
      if (!server.sessionId) {
        // No session yet: there is nothing to abort, so stop the server itself.
        await server.cleanup();
        return;
      }
      try {
        const response = await fetch(
          `${server.serverUrl}/session/${encodeURIComponent(server.sessionId)}/abort`,
          { method: "POST" },
        );
        if (!response.ok) {
          await server.cleanup();
        }
      } catch {
        await server.cleanup();
      }
      return;
    }

    if (!this.children.has(runId)) return;
    this.cancelled.add(runId);
    const outcome = await processSupervisor.terminate(runId);
    if (!outcome.stopped) {
      throw new Error(
        `could not stop the opencode process tree for ${runId}: ${outcome.reason} (pids ${outcome.survivingPids.join(", ")})`,
      );
    }
  }

  private async readVersion(bin: string): Promise<string | undefined> {
    return await new Promise<string | undefined>((resolve) => {
      let stdout = "";
      let settled = false;
      const child = spawnOpenCode(bin, [...this.extraArgs, "--version"], process.cwd());
      const finish = (value: string | undefined) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => {
        child.kill();
        finish(undefined);
      }, 10_000);
      child.stdout?.on("data", (data: Buffer) => {
        stdout += data.toString();
      });
      child.on("error", () => finish(undefined));
      child.on("close", () => finish(stdout.trim().split(/\r?\n/)[0]?.trim() || undefined));
    });
  }

  private async checkAuth(bin: string): Promise<boolean> {
    try {
      const output = await new Promise<string>((resolve, reject) => {
        let data = "";
        const child = spawnOpenCode(bin, [...this.extraArgs, "providers", "list"], process.cwd());
        child.stdout?.on("data", (d: Buffer) => { data += d.toString(); });
        child.on("error", reject);
        child.on("close", (code) => {
          resolve(code === 0 ? data : "");
        });
      });
      return output.includes("●") || output.includes("Credentials") || output.includes("environment");
    } catch {
      return false;
    }
  }
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

async function waitForServer(url: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(`${url}/global/health`, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return;
    } catch {
      await sleep(200);
    }
  }
  throw new Error(`opencode server did not become ready within ${timeoutMs}ms`);
}

async function createSession(serverUrl: string, body: Record<string, unknown>): Promise<{ id: string }> {
  const response = await fetch(`${serverUrl}/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`create session failed: ${response.status}`);
  return await response.json() as { id: string };
}

async function sendPrompt(
  serverUrl: string,
  sessionId: string,
  body: Record<string, unknown>,
): Promise<{ info: Record<string, unknown>; parts: Array<Record<string, unknown>> }> {
  const response = await fetch(`${serverUrl}/session/${encodeURIComponent(sessionId)}/message`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`prompt failed: ${response.status}`);
  return await response.json() as { info: Record<string, unknown>; parts: Array<Record<string, unknown>> };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
