import path from "node:path";
import readline from "node:readline";
import { processSupervisor } from "@bremio/adapter-sdk";
import type {
  AgentAdapter,
  AgentCapabilities,
  AgentHealth,
  AgentRunRequest,
  AgentToolVocabulary,
  AdapterRuntimeCapabilities,
  ModelDescriptor,
} from "@bremio/adapter-sdk";
import type { AgentEvent } from "@bremio/protocol";
import {
  agyLooksSignedIn,
  formatPrintTimeout,
  resolveAgyBinary,
  spawnAgy,
  type AgyChild,
} from "./agy-cli";

export interface AntigravityAdapterOptions {
  /** Explicit path to the `agy` executable (default: BREMIO_AGY_BIN, PATH, install dir). */
  agyBin?: string;
  /** Arguments placed before the agy flags, e.g. a script path when testing. */
  agyArgs?: string[];
  /** Model label passed to `--model`, e.g. "Gemini 3.5 Flash (High)". */
  defaultModel?: string;
  /** Fallback timeout when a request does not set one. */
  defaultTimeoutMs?: number;
  /**
   * Opt in to `--dangerously-skip-permissions`, which auto-approves **every**
   * tool request `agy` makes — file writes, shell commands, network — with no
   * prompt and no record of what was approved.
   *
   * Off by default, and deliberately not implied by `workspace-write`. Ordinary
   * writable work used to enable it silently, so any task allowed to edit a file
   * was also, unannounced, allowed to run any command.
   *
   * There is no safe middle ground on the CLI today: `agy 1.1.5`'s
   * `--mode accept-edits` auto-*denies* in headless mode ("a tool required the
   * write_file permission that headless mode cannot prompt for"). The scoped
   * alternative agy documents is a `permissions.allow` rule in its settings,
   * which Bremio does not yet manage — see docs/15 §1.4.
   */
  allowDangerousPermissionBypass?: boolean;
}

/**
 * Raised before spawning when a writable run has no honest way to proceed.
 *
 * Failing here costs nothing: verified against agy 1.1.5, a writable run
 * without the bypass returns in ~8s having auto-denied its own file write, so
 * spawning would burn quota to accomplish nothing.
 */
export class AntigravityPermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AntigravityPermissionError";
  }
}

const DEFAULT_TIMEOUT_MS = 10 * 60_000;

const INSTALL_HINT =
  'install it with: irm https://antigravity.google/cli/install.ps1 | iex (Windows) or curl -fsSL https://antigravity.google/cli/install.sh | bash';

/**
 * Capabilities of the `agy` CLI path, verified against agy 1.1.4.
 *
 * `structuredOutput` is FALSE: `agy --print` emits prose only — there is no
 * `--output-format json` and no machine-readable event stream. That is what
 * makes Antigravity ineligible to lead (lead requires planning &&
 * structuredOutput), and it is recorded as a capability rather than a special
 * case so the router enforces it without provider-specific branching.
 *
 * `testing` is FALSE because prose output exposes no reliable command exit
 * codes, so Antigravity cannot serve as a test gate.
 */
const CAPABILITIES: AgentCapabilities = {
  planning: false,
  structuredOutput: false,
  repositoryRead: true,
  repositoryWrite: true,
  shell: true,
  testing: false,
  browser: false,
  vision: false,
  resumableSessions: false,
  // --mode plan refuses writes headlessly without --dangerously-skip-permissions
  // → provider-native.
  readOnlyEnforcement: "provider-native",
};

export interface AgyInvocation {
  args: string[];
  workspace: string;
}

/**
 * Build the `agy` argument vector for a Bremio request.
 *
 * Verified behaviour that shapes this (agy 1.1.4):
 * - `agy` IGNORES the spawned process cwd and writes into its own scratch
 *   workspace unless `--add-dir` names the target directory, so `--add-dir`
 *   is mandatory and the prompt restates the workspace root.
 * - read-only maps to `--mode plan`, which refuses writes but still returns
 *   prose. workspace-write has no safe CLI mapping: verified against agy 1.1.5,
 *   `--mode accept-edits` auto-*denies* headlessly because it cannot prompt, so
 *   the only flag that lets a write through is `--dangerously-skip-permissions`
 *   — which approves shell and network too. It is therefore opt-in
 *   (`allowDangerousPermissionBypass`) rather than implied by being writable,
 *   and a writable run without it is refused before spawn. See docs/15 §1.4.
 */
export function buildAgyInvocation(
  req: AgentRunRequest,
  options: {
    defaultModel?: string;
    defaultTimeoutMs?: number;
    allowDangerousPermissionBypass?: boolean;
  } = {},
): AgyInvocation {
  const workspace = path.resolve(req.cwd);
  // `--print-timeout` is only a provider-side safety net; real cancellation and
  // per-task deadlines come from the orchestrator via `req.signal`.
  const timeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const readOnly = req.permission === "read-only";

  const prompt = [
    `Workspace root: ${workspace}`,
    "Work only inside that directory; treat it as the repository root.",
    "",
    req.prompt,
  ].join("\n");

  const args = [
    "-p",
    prompt,
    "--add-dir",
    workspace,
    "--print-timeout",
    formatPrintTimeout(timeoutMs),
  ];
  if (readOnly) {
    args.push("--mode", "plan");
  } else if (options.allowDangerousPermissionBypass) {
    args.push("--dangerously-skip-permissions");
  } else {
    // Refused rather than quietly downgraded to read-only: a caller that asked
    // for a writable run and silently got a read-only one would read the
    // agent's "I was unable to edit the file" as a capability problem.
    throw new AntigravityPermissionError(
      'antigravity cannot run with write access unless "--dangerously-skip-permissions" is ' +
        "enabled, and that flag auto-approves every tool it uses — file writes, shell commands " +
        "and network alike — not only the edits this task needs.\n" +
        "Set allowDangerousPermissionBypass: true on the adapter to accept that, or run this " +
        "task read-only. Scoped permissions are tracked in docs/15 §1.4.",
    );
  }

  const model = req.model ?? options.defaultModel;
  if (model) args.push("--model", model);

  return { args, workspace };
}

/**
 * AgentAdapter over the authenticated `agy` CLI, so Antigravity work is billed
 * to the user's existing Google AI subscription rather than a separate API key.
 *
 * The stream is intentionally thin: `agy` prints prose, so Bremio emits one
 * `message` event per output line plus a terminal `completed`. There are no
 * tool_use/usage events because the CLI exposes none — Bremio reports what the
 * provider actually gives instead of inventing structure.
 */
export class AntigravityAdapter implements AgentAdapter {
  readonly id = "antigravity";
  readonly provider = "google";

  getToolVocabulary(): AgentToolVocabulary {
    return { read: [], write: [], shell: [] };
  }

  private readonly explicitBin: string | undefined;
  private readonly agyArgs: string[];
  private readonly defaultModel: string | undefined;
  private readonly defaultTimeoutMs: number;
  private readonly allowDangerousPermissionBypass: boolean;
  private readonly children = new Map<string, AgyChild>();
  private readonly cancelled = new Set<string>();

  constructor(options: AntigravityAdapterOptions = {}) {
    this.explicitBin = options.agyBin;
    this.agyArgs = options.agyArgs ?? [];
    this.defaultModel = options.defaultModel;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    // Defaults to false: the dangerous flag must be asked for, never inherited
    // from a task merely being writable.
    this.allowDangerousPermissionBypass = options.allowDangerousPermissionBypass ?? false;
  }

  async getCapabilities(): Promise<AgentCapabilities> {
    return CAPABILITIES;
  }

  async getRuntimeCapabilities(): Promise<AdapterRuntimeCapabilities> {
    return {
      adapterId: this.id,
      transport: "cli",
      approval: "none", // no per-action seam — all-or-nothing per run
      structuredToolEvents: false,
      contextMetrics: "estimated",
      manualCompact: false,
      mcp: false,
      webSearch: false,
      cancellation: false,
    };
  }

  /**
   * `agy models` lists display labels with the reasoning tier baked in
   * ("Gemini 3.5 Flash (High)"). These are NOT provider model ids, so they are
   * surfaced as labels and never recorded as confirmed model identity.
   */
  async listModels(): Promise<ModelDescriptor[]> {
    return [
      { id: "Gemini 3.5 Flash (Medium)", displayName: "Gemini 3.5 Flash (Medium)", default: true },
      { id: "Gemini 3.5 Flash (High)", displayName: "Gemini 3.5 Flash (High)" },
      { id: "Gemini 3.1 Pro (High)", displayName: "Gemini 3.1 Pro (High)" },
      { id: "Claude Sonnet 4.6 (Thinking)", displayName: "Claude Sonnet 4.6 (Thinking)" },
    ];
  }

  async healthCheck(): Promise<AgentHealth> {
    const bin = resolveAgyBinary(this.explicitBin);
    if (!bin) {
      return { status: "unavailable", detail: `agy CLI not found; ${INSTALL_HINT}` };
    }

    const version = await this.readVersion(bin);
    if (!version) {
      return { status: "unavailable", detail: `agy at ${bin} did not report a version` };
    }
    if (!agyLooksSignedIn()) {
      return {
        status: "degraded",
        detail: `agy ${version}; run 'agy' once in a terminal to sign in with your Google account`,
      };
    }
    return { status: "ok", detail: `agy ${version}; signed in (subscription quota)` };
  }

  async *startRun(req: AgentRunRequest): AsyncIterable<AgentEvent> {
    const now = () => Date.now();
    yield { type: "started", runId: req.runId, ts: now() };

    const bin = resolveAgyBinary(this.explicitBin);
    if (!bin) {
      yield {
        type: "completed",
        runId: req.runId,
        ts: now(),
        outcome: { status: "failed", error: `agy CLI not found; ${INSTALL_HINT}` },
      };
      return;
    }

    // Built before the spawn so a refused permission combination is reported as
    // a failed run rather than a rejected promise the caller cannot attribute.
    let args: string[];
    try {
      ({ args } = buildAgyInvocation(req, {
        ...(this.defaultModel ? { defaultModel: this.defaultModel } : {}),
        defaultTimeoutMs: this.defaultTimeoutMs,
        allowDangerousPermissionBypass: this.allowDangerousPermissionBypass,
      }));
    } catch (err) {
      if (!(err instanceof AntigravityPermissionError)) throw err;
      yield { type: "started", runId: req.runId, ts: Date.now() };
      yield {
        type: "completed",
        runId: req.runId,
        ts: Date.now(),
        outcome: { status: "failed", error: err.message },
      };
      return;
    }

    let spawnError: Error | undefined;
    let stderr = "";
    const lines: string[] = [];
    const child = spawnAgy(bin, [...this.agyArgs, ...args]);
    this.children.set(req.runId, child);
    processSupervisor.adopt(req.runId, child);
    child.on("error", (error) => {
      spawnError = error;
    });
    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });
    const exit = new Promise<number | null>((resolve) => child.on("close", resolve));

    const onAbort = () => void this.cancelRun(req.runId);
    req.signal?.addEventListener("abort", onAbort, { once: true });
    if (req.signal?.aborted) void this.cancelRun(req.runId);

    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    try {
      for await (const line of rl) {
        if (!line.trim()) continue;
        lines.push(line);
        yield { type: "message", runId: req.runId, ts: now(), role: "assistant", text: line };
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
        message: `agy stderr: ${stderr.trim().slice(-2_000)}`,
      };
    }

    const wasCancelled = this.cancelled.delete(req.runId);
    const finalText = lines.join("\n").trim();
    const status = wasCancelled ? "cancelled" : code === 0 ? "completed" : "failed";
    const error =
      status === "failed"
        ? spawnError?.message ??
          `agy exited with code ${code}${stderr.trim() ? `: ${stderr.trim().slice(-500)}` : ""}`
        : undefined;

    yield {
      type: "completed",
      runId: req.runId,
      ts: now(),
      outcome: {
        status,
        ...(finalText ? { finalText } : {}),
        ...(error ? { error } : {}),
      },
    };
  }

  resumeRun(_sessionId: string, _request: AgentRunRequest): AsyncIterable<AgentEvent> {
    throw new Error("Antigravity resumeRun is not implemented (agy --continue is not wired)");
  }

  /**
   * Ask the supervisor to stop the whole tree and report whether it did.
   * `agy` spawns its own children, so killing this pid alone left them running.
   */
  async cancelRun(runId: string): Promise<void> {
    if (!this.children.has(runId)) return;
    this.cancelled.add(runId);
    const outcome = await processSupervisor.terminate(runId);
    if (!outcome.stopped) {
      throw new Error(
        `could not stop the agy process tree for ${runId}: ${outcome.reason} (pids ${outcome.survivingPids.join(", ")})`,
      );
    }
  }

  private async readVersion(bin: string): Promise<string | undefined> {
    return await new Promise<string | undefined>((resolve) => {
      let stdout = "";
      let settled = false;
      const child = spawnAgy(bin, [...this.agyArgs, "--version"]);
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
      child.stdout.on("data", (data: Buffer) => {
        stdout += data.toString();
      });
      child.on("error", () => finish(undefined));
      child.on("close", () => finish(stdout.trim().split(/\r?\n/)[0]?.trim() || undefined));
    });
  }
}
