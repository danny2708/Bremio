import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { processSupervisor } from "@bremio/adapter-sdk";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type {
  AgentAdapter,
  AgentCapabilities,
  AgentHealth,
  AgentRunRequest,
  ModelDescriptor,
} from "@bremio/adapter-sdk";
import type { AgentEvent } from "@bremio/protocol";
import { mapCodexLine } from "./events";
import { spawnCodex } from "./spawn";

export interface CodexAdapterOptions {
  /** Path/name of the codex binary. Default: "codex" (resolved on PATH). */
  bin?: string;
}

/** Keep internal run ids safe when embedded in Windows/Unix temp filenames. */
export function sanitizeRunIdForFile(runId: string): string {
  return runId.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 80) || "run";
}

const CAPABILITIES: AgentCapabilities = {
  planning: true,
  structuredOutput: true, // native via `--output-schema`
  repositoryRead: true,
  repositoryWrite: true,
  shell: true,
  testing: true,
  browser: false,
  vision: false,
  resumableSessions: true,
};

export function buildCodexExecArgs(
  req: AgentRunRequest,
  outFile: string,
  schemaFile?: string,
): string[] {
  const sandbox = req.permission === "read-only" ? "read-only" : "workspace-write";
  const args = [
    "exec",
    "--json",
    "--color",
    "never",
    "-C",
    req.cwd,
    "-s",
    sandbox,
    "-o",
    outFile,
  ];
  if (schemaFile) args.push("--output-schema", schemaFile);
  if (req.model) args.push("-m", req.model);
  if (req.reasoningLevel) {
    args.push("-c", `model_reasoning_effort=${JSON.stringify(req.reasoningLevel)}`);
  }
  return args;
}

export function buildCodexResumeArgs(
  sessionId: string,
  req: AgentRunRequest,
  outFile: string,
  schemaFile?: string,
): string[] {
  const sandbox = req.permission === "read-only" ? "read-only" : "workspace-write";
  const args = [
    "exec",
    "resume",
    sessionId,
    "--json",
    "--color",
    "never",
    "-C",
    req.cwd,
    "-s",
    sandbox,
    "-o",
    outFile,
  ];
  if (schemaFile) args.push("--output-schema", schemaFile);
  if (req.model) args.push("-m", req.model);
  if (req.reasoningLevel) {
    args.push("-c", `model_reasoning_effort=${JSON.stringify(req.reasoningLevel)}`);
  }
  return args;
}

export class CodexAdapter implements AgentAdapter {
  readonly id = "codex";
  readonly provider = "openai";

  private readonly bin: string;
  private readonly children = new Map<string, ChildProcessWithoutNullStreams>();
  private readonly cancelled = new Set<string>();

  constructor(options: CodexAdapterOptions = {}) {
    this.bin = options.bin ?? "codex";
  }

  async getCapabilities(): Promise<AgentCapabilities> {
    return CAPABILITIES;
  }

  async listModels(): Promise<ModelDescriptor[]> {
    // Informational; runs use codex's configured default unless a model is set.
    return [
      { id: "gpt-5.6-sol", displayName: "GPT-5.6 Sol (flagship)" },
      { id: "gpt-5.6-terra", displayName: "GPT-5.6 Terra (workhorse)", default: true },
      { id: "gpt-5.6-luna", displayName: "GPT-5.6 Luna (fast)" },
    ];
  }

  async healthCheck(): Promise<AgentHealth> {
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        const child = spawnCodex(this.bin, ["--version"], process.cwd());
        child.on("error", reject);
        child.on("close", resolve);
      });
      return code === 0
        ? { status: "ok" }
        : { status: "degraded", detail: `codex --version exited ${code}` };
    } catch (err) {
      return {
        status: "unavailable",
        detail: `codex not runnable: ${(err as Error).message}`,
      };
    }
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

    const token = randomBytes(4).toString("hex");
    const safeRunId = sanitizeRunIdForFile(req.runId);
    const outFile = path.join(os.tmpdir(), `bremio-codex-${safeRunId}-${token}.txt`);
    let schemaFile: string | undefined;
    if (req.outputSchema) {
      schemaFile = path.join(os.tmpdir(), `bremio-codex-${safeRunId}-${token}.schema.json`);
      await fs.writeFile(schemaFile, JSON.stringify(req.outputSchema), "utf8");
    }

    const args = resumeSessionId
      ? buildCodexResumeArgs(resumeSessionId, req, outFile, schemaFile)
      : buildCodexExecArgs(req, outFile, schemaFile);

    let spawnError: Error | undefined;
    let stderr = "";
    let capturedSessionId = resumeSessionId;

    const child = spawnCodex(this.bin, args, req.cwd);
    this.children.set(req.runId, child);
    processSupervisor.adopt(req.runId, child);

    child.on("error", (e) => {
      spawnError = e;
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });

    const onAbort = () => void this.cancelRun(req.runId);
    req.signal?.addEventListener("abort", onAbort, { once: true });
    if (req.signal?.aborted) void this.cancelRun(req.runId);

    const exit = new Promise<number | null>((resolve) => {
      child.on("close", (code) => resolve(code));
    });

    child.stdin.write(req.prompt);
    child.stdin.end();

    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    try {
      for await (const line of rl) {
        if (!capturedSessionId && line.includes("thread.started")) {
          try {
            const parsed = JSON.parse(line.trim());
            if (parsed.thread_id) capturedSessionId = String(parsed.thread_id);
          } catch {}
        }
        for (const ev of mapCodexLine(line, req.runId)) yield ev;
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
        message: `codex stderr: ${stderr.trim().slice(-2000)}`,
      };
    }

    let finalText: string | undefined;
    try {
      const raw = (await fs.readFile(outFile, "utf8")).trim();
      finalText = raw.length > 0 ? raw : undefined;
    } catch {
      // no output file
    }
    await fs.rm(outFile, { force: true }).catch(() => {});
    if (schemaFile) await fs.rm(schemaFile, { force: true }).catch(() => {});

    const wasCancelled = this.cancelled.delete(req.runId);
    const status = wasCancelled ? "cancelled" : code === 0 ? "completed" : "failed";
    const error =
      status === "failed"
        ? spawnError
          ? spawnError.message
          : `codex exec exited with code ${code}${stderr ? `: ${stderr.trim().slice(-500)}` : ""}`
        : undefined;

    yield {
      type: "completed",
      runId: req.runId,
      ts: now(),
      outcome: {
        status,
        ...(finalText ? { finalText } : {}),
        ...(error ? { error } : {}),
        ...(capturedSessionId ? { sessionId: capturedSessionId } : {}),
      },
    };
  }

  /**
   * Ask the supervisor to stop the whole tree and report whether it did.
   * Returning without confirmation would let a caller announce a cancellation
   * while `codex` and its children were still writing.
   */
  async cancelRun(runId: string): Promise<void> {
    if (!this.children.has(runId)) return;
    this.cancelled.add(runId);
    const outcome = await processSupervisor.terminate(runId);
    if (!outcome.stopped) {
      throw new Error(
        `could not stop the codex process tree for ${runId}: ${outcome.reason} (pids ${outcome.survivingPids.join(", ")})`,
      );
    }
  }
}
