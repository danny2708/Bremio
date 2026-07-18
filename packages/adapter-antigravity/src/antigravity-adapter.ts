import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import readline from "node:readline";
import type {
  AgentAdapter,
  AgentCapabilities,
  AgentHealth,
  AgentRunRequest,
  ModelDescriptor,
} from "@bremio/adapter-sdk";
import { AgentEventSchema, type AgentEvent } from "@bremio/protocol";

export interface AntigravityAdapterOptions {
  /** Python interpreter containing google-antigravity (default: env override or python). */
  pythonBin?: string;
  /** Arguments placed before the sidecar path, e.g. ["-3.12"] for py.exe. */
  pythonArgs?: string[];
  /** Test/development override for the bundled sidecar. */
  sidecarPath?: string;
  defaultModel?: string;
}

export interface AntigravitySidecarRequest {
  runId: string;
  prompt: string;
  cwd: string;
  permission: "read-only" | "workspace-write";
  model?: string;
  reasoningLevel?: "low" | "medium" | "high" | "xhigh";
  systemPrompt?: string;
  outputSchema?: Record<string, unknown>;
}

const CAPABILITIES: AgentCapabilities = {
  planning: false,
  structuredOutput: true,
  repositoryRead: true,
  repositoryWrite: true,
  shell: true,
  // The SDK does not expose reliable command exit codes in ChatResponse 0.1.7,
  // so Bremio cannot yet treat it as a test-gate agent.
  testing: false,
  browser: false,
  vision: false,
  resumableSessions: false,
};

export function buildAntigravityRequest(
  req: AgentRunRequest,
  defaultModel?: string,
): AntigravitySidecarRequest {
  return {
    runId: req.runId,
    prompt: req.prompt,
    cwd: req.cwd,
    permission: req.permission,
    ...(req.model ?? defaultModel ? { model: req.model ?? defaultModel } : {}),
    ...(req.reasoningLevel ? { reasoningLevel: req.reasoningLevel } : {}),
    ...(req.systemPrompt ? { systemPrompt: req.systemPrompt } : {}),
    ...(req.outputSchema ? { outputSchema: req.outputSchema } : {}),
  };
}

export class AntigravityAdapter implements AgentAdapter {
  readonly id = "antigravity";
  readonly provider = "google";

  private readonly pythonBin: string;
  private readonly pythonArgs: string[];
  private readonly sidecarPath: string;
  private readonly defaultModel: string | undefined;
  private readonly children = new Map<string, ChildProcessWithoutNullStreams>();
  private readonly cancelled = new Set<string>();

  constructor(options: AntigravityAdapterOptions = {}) {
    this.pythonBin = options.pythonBin ?? process.env.BREMIO_ANTIGRAVITY_PYTHON ?? "python";
    this.pythonArgs = options.pythonArgs ?? [];
    this.sidecarPath = options.sidecarPath ?? fileURLToPath(new URL("./sidecar.py", import.meta.url));
    this.defaultModel = options.defaultModel;
  }

  async getCapabilities(): Promise<AgentCapabilities> {
    return CAPABILITIES;
  }

  async listModels(): Promise<ModelDescriptor[]> {
    return [{ id: "gemini-3.5-flash", displayName: "Gemini 3.5 Flash", default: true }];
  }

  async healthCheck(): Promise<AgentHealth> {
    return await new Promise<AgentHealth>((resolve) => {
      let stdout = "";
      let stderr = "";
      let settled = false;
      const child = this.spawnSidecar(["--health"], process.cwd());
      const finish = (health: AgentHealth) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(health);
      };
      const timer = setTimeout(() => {
        child.kill();
        finish({ status: "unavailable", detail: "Antigravity SDK health check timed out" });
      }, 5_000);
      child.stdout.on("data", (data: Buffer) => { stdout += data.toString(); });
      child.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });
      child.on("error", (error) => finish({
        status: "unavailable",
        detail: `Python sidecar is not runnable: ${error.message}`,
      }));
      child.on("close", () => {
        const line = stdout.trim().split(/\r?\n/).at(-1);
        if (line) {
          try {
            const parsed = JSON.parse(line) as AgentHealth;
            if (["ok", "degraded", "unavailable"].includes(parsed.status)) {
              finish(parsed);
              return;
            }
          } catch {
            // Fall through to one stable diagnostic.
          }
        }
        finish({
          status: "unavailable",
          detail: stderr.trim().slice(-500) || "Antigravity sidecar returned no health result",
        });
      });
    });
  }

  async *startRun(req: AgentRunRequest): AsyncIterable<AgentEvent> {
    const now = () => Date.now();
    yield { type: "started", runId: req.runId, ts: now() };

    let spawnError: Error | undefined;
    let stderr = "";
    let terminal = false;
    const child = this.spawnSidecar([], req.cwd);
    this.children.set(req.runId, child);
    const exit = new Promise<number | null>((resolve) => child.on("close", resolve));
    child.on("error", (error) => { spawnError = error; });
    child.stdin.on("error", () => {});
    child.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });

    const onAbort = () => void this.cancelRun(req.runId);
    req.signal?.addEventListener("abort", onAbort, { once: true });
    if (req.signal?.aborted) void this.cancelRun(req.runId);

    child.stdin.end(`${JSON.stringify(buildAntigravityRequest(req, this.defaultModel))}\n`);
    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    try {
      for await (const line of rl) {
        if (!line.trim()) continue;
        let raw: unknown;
        try {
          raw = JSON.parse(line);
        } catch {
          yield {
            type: "log",
            runId: req.runId,
            ts: now(),
            level: "warn",
            message: `Antigravity sidecar emitted invalid JSON: ${line.slice(0, 300)}`,
          };
          continue;
        }
        const parsed = AgentEventSchema.safeParse(raw);
        if (!parsed.success || parsed.data.runId !== req.runId) {
          yield {
            type: "log",
            runId: req.runId,
            ts: now(),
            level: "warn",
            message: "Antigravity sidecar emitted an invalid event",
          };
          continue;
        }
        if (parsed.data.type === "completed") terminal = true;
        yield parsed.data;
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
        message: `Antigravity stderr: ${stderr.trim().slice(-2_000)}`,
      };
    }
    const cancelled = this.cancelled.delete(req.runId);
    if (!terminal) {
      const status = cancelled ? "cancelled" : "failed";
      const error = cancelled
        ? undefined
        : spawnError?.message ?? `Antigravity sidecar exited with code ${code}`;
      yield {
        type: "completed",
        runId: req.runId,
        ts: now(),
        outcome: { status, ...(error ? { error } : {}) },
      };
    }
  }

  resumeRun(): AsyncIterable<AgentEvent> {
    throw new Error("Antigravity resumeRun is not implemented in Phase 1.5");
  }

  async cancelRun(runId: string): Promise<void> {
    const child = this.children.get(runId);
    if (!child) return;
    this.cancelled.add(runId);
    child.kill();
  }

  private spawnSidecar(extraArgs: string[], cwd: string): ChildProcessWithoutNullStreams {
    return spawn(
      this.pythonBin,
      [...this.pythonArgs, this.sidecarPath, ...extraArgs],
      { cwd, env: process.env, shell: false, stdio: ["pipe", "pipe", "pipe"] },
    );
  }
}
