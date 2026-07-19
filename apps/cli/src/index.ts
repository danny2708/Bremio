import { existsSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { pino } from "pino";
import { AntigravityAdapter } from "@bremio/adapter-antigravity";
import { ClaudeAdapter } from "@bremio/adapter-claude";
import { CodexAdapter } from "@bremio/adapter-codex";
import {
  LeadPlanError,
  PlanValidationError,
  createRegistry,
  runBremio,
  runSingleAgent,
  type RunBremioHooks,
  type SingleRunHooks,
} from "@bremio/orchestrator";
import { ExecutionModeSchema, type ReasoningLevel } from "@bremio/protocol";
import {
  DEFAULT_STALE_AFTER_SECONDS,
  defaultAqtDatabasePath,
  readAqtQuota,
  toAqtCapacitySnapshots,
  type AgentCapacitySnapshot,
} from "@bremio/quota";
import {
  DaemonAlreadyRunningError,
  daemonStatus,
  startDaemon,
  stopDaemon,
} from "@bremio/daemon";
import { mergeCommand } from "./merge";
import { capacityCommand } from "./quota";
import { statsCommand } from "./stats";
import { canUseTui, startTui } from "./tui";
import { c, compactEvent, printPlan, printReport, statusGlyph } from "./ui";

declare const __BREMIO_VERSION__: string | undefined;
const VERSION = typeof __BREMIO_VERSION__ === "string"
  ? __BREMIO_VERSION__
  : process.env.npm_package_version ?? "dev";

const USAGE = `${c.bold("bremio")} — provider-agnostic orchestrator for AI coding agents

${c.bold("Usage")}
  bremio                                  launch the interactive TUI (needs a terminal)
  bremio tui [--repo <path>]              same, explicitly
  bremio run --mode single --agent <claude|codex|antigravity> --repo <path> "<prompt>"
  bremio run --mode team --lead <claude|codex> [--worker <agent>] --repo <path> "<prompt>"
  bremio merge <taskId> [--run <runId>] [--strategy <merge|cherry-pick>] [--yes]
  bremio stats [--since <date>] [--repo <path>]
  bremio capacity [--db <path>] [--aging-after <minutes>] [--stale-after <minutes>]
  bremio quota [--db <path>] [--aging-after <minutes>] [--stale-after <minutes>]
  bremio daemon [start|status|stop|restart]   manage the local daemon (HTTP + SSE, loopback)
  bremio update                           how to update the CLI, daemon and extension
  bremio doctor
  bremio --version
  bremio --help

${c.bold("run")}      run one agent directly or orchestrate an isolated team
  --mode <single|team>    Explicit execution mode. Required for new commands.
  --agent <agent>         Agent for Single mode: claude, codex, or antigravity.
  --lead <claude|codex>   Lead for Team mode. Without --mode, implies Team.
  --worker <agent>        Explicit Team worker (including antigravity).
  --repo <path>           Target git repository. Required.
  --model <id>            Model for the Single agent or Team lead (optional).
  --reasoning <level>     Single-agent or Team-lead reasoning level.
  --timeout <seconds>     Hard timeout for the Single run or each Team task.
  --concurrency <n>       Team tasks to run at once (default: 2, dependency-safe).
  --capacity-routing      Opt in to conservative Team capacity routing.
  --db <path>             Override the AQT database used for capacity routing.
  --comparison <id>       Link this run to a controlled Single/Team experiment.
  --json                  Print the report as JSON (suppresses progress).
  --verbose               Emit structured operational logs to stderr.

${c.bold("merge")}    review a completed task's diff, then merge it into the base branch
  <taskId>                The task to merge (e.g. TASK-002).
  --run <runId>           Merge every task in a run (or disambiguate a taskId).
  --repo <path>           Repo to look in (default: current directory).
  --base <branch>         Override the merge target (default: run's base branch).
  --strategy <mode>       Integrate task branches with merge (default) or cherry-pick.
  --yes                   Skip the confirmation prompt.

${c.bold("stats")}    summarize the usage ledger (.bremio/ledger.jsonl)
  --since <date>          Only count tasks on/after this date (e.g. 2026-07-01).
  --repo <path>           Repo to look in (default: current directory).

${c.bold("capacity")} show canonical agent capacity from AI-Quota-Tray's SQLite database
${c.bold("quota")}    backward-compatible alias for capacity
  --db <path>             Override the default AI-Quota-Tray database path.
  --no-refresh            Read last-known data without asking AQT to fetch.
  --aging-after <minutes> Degrade source confidence after this age (default: 15).
  --stale-after <minutes> Treat older snapshots as unknown (default: 30).`;

function parseCli() {
  return parseArgs({
    allowPositionals: true,
    options: {
      mode: { type: "string" },
      agent: { type: "string" },
      lead: { type: "string" },
      worker: { type: "string" },
      repo: { type: "string" },
      prompt: { type: "string" },
      model: { type: "string" },
      reasoning: { type: "string" },
      timeout: { type: "string" },
      concurrency: { type: "string" },
      run: { type: "string" },
      base: { type: "string" },
      strategy: { type: "string" },
      since: { type: "string" },
      db: { type: "string" },
      "aging-after": { type: "string" },
      "stale-after": { type: "string" },
      "capacity-routing": { type: "boolean", default: false },
      // parseArgs has no `--no-x` negation, so the opt-out is its own flag.
      "no-refresh": { type: "boolean", default: false },
      comparison: { type: "string" },
      json: { type: "boolean", default: false },
      verbose: { type: "boolean", default: false },
      yes: { type: "boolean", short: "y", default: false },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false },
    },
  });
}

type Values = ReturnType<typeof parseCli>["values"];

async function main(): Promise<void> {
  const { values, positionals } = parseCli();
  const command = positionals[0];

  if (values.version) {
    console.log(VERSION);
    return;
  }
  if (values.help) {
    console.log(USAGE);
    return;
  }
  // Bare `bremio` opens the TUI when attached to a terminal; piped/CI callers
  // still get the usage text so scripts keep working unchanged.
  if (!command) {
    if (canUseTui()) {
      await startTui({ version: VERSION, ...(values.repo ? { repoPath: values.repo } : {}) });
    } else {
      console.log(USAGE);
    }
    return;
  }

  switch (command) {
    case "tui":
      if (!canUseTui()) {
        console.error(c.red("error: the TUI needs an interactive terminal (TTY)"));
        process.exitCode = 2;
        return;
      }
      await startTui({ version: VERSION, ...(values.repo ? { repoPath: values.repo } : {}) });
      return;
    case "run":
      await runCommand(values, positionals);
      return;
    case "merge":
      process.exitCode = await mergeCommandFromCli(values, positionals);
      return;
    case "stats":
      process.exitCode = await statsCommandFromCli(values);
      return;
    case "capacity":
    case "quota":
      process.exitCode = await quotaCommandFromCli(values);
      return;
    case "daemon":
      process.exitCode = await daemonCommandFromCli(positionals[1]);
      return;
    case "update":
      updateCommand();
      return;
    case "doctor":
      await doctor();
      return;
    default:
      console.error(c.red(`unknown command: ${command}`));
      console.log(USAGE);
      process.exitCode = 2;
  }
}

async function runCommand(values: Values, positionals: string[]): Promise<void> {
  const prompt = (values.prompt ?? positionals.slice(1).join(" ")).trim();
  const errors: string[] = [];
  const requestedMode = values.mode ?? (values.lead ? "team" : undefined);
  const parsedMode = ExecutionModeSchema.safeParse(requestedMode);
  const mode = parsedMode.success ? parsedMode.data : undefined;
  if (!parsedMode.success) {
    errors.push("--mode must be 'single' or 'team'");
  }
  const agentIds = new Set(["claude", "codex", "antigravity"]);
  if (mode === "single" && !agentIds.has(values.agent ?? "")) {
    errors.push("Single mode requires --agent 'claude', 'codex', or 'antigravity'");
  }
  if (mode === "team" && values.lead !== "claude" && values.lead !== "codex") {
    errors.push("Team mode requires --lead 'claude' or 'codex'");
  }
  if (mode === "single" && values.lead) {
    errors.push("--lead is only valid in Team mode; use --agent for Single mode");
  }
  if (mode === "single" && values.worker) {
    errors.push("--worker is only valid in Team mode");
  }
  if (mode === "team" && values.worker && !agentIds.has(values.worker)) {
    errors.push("--worker must be 'claude', 'codex', or 'antigravity'");
  }
  if (mode === "team" && values.worker === values.lead) {
    errors.push("--worker must be different from --lead");
  }
  if (mode === "team" && values.agent) {
    errors.push("--agent is only valid in Single mode; use --lead for Team mode");
  }
  if (mode === "single" && values["capacity-routing"]) {
    errors.push("--capacity-routing is only valid in Team mode");
  }
  if (!values.repo) errors.push("--repo <path> is required");
  if (!prompt) errors.push('a prompt is required, e.g. bremio run ... "add a health endpoint"');
  const timeoutSeconds = values.timeout === undefined ? undefined : Number(values.timeout);
  if (timeoutSeconds !== undefined && (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0)) {
    errors.push("--timeout must be a positive number of seconds");
  }
  const concurrency = values.concurrency === undefined ? undefined : Number(values.concurrency);
  if (
    concurrency !== undefined &&
    (!Number.isInteger(concurrency) || concurrency < 1)
  ) {
    errors.push("--concurrency must be a positive whole number of tasks");
  }
  if (concurrency !== undefined && mode === "single") {
    errors.push("--concurrency is only valid in Team mode");
  }
  const reasoningLevels = new Set<ReasoningLevel>(["low", "medium", "high", "xhigh"]);
  if (values.reasoning && !reasoningLevels.has(values.reasoning as ReasoningLevel)) {
    errors.push("--reasoning must be 'low', 'medium', 'high', or 'xhigh'");
  }
  if (values.comparison !== undefined && values.comparison.trim().length === 0) {
    errors.push("--comparison must be a non-empty experiment id");
  }
  const capacityTiming = parseCapacityTiming(values);
  if (values["capacity-routing"] && capacityTiming.error) {
    errors.push(capacityTiming.error);
  }
  if (errors.length) {
    for (const e of errors) console.error(c.red(`error: ${e}`));
    console.log(`\n${USAGE}`);
    process.exitCode = 2;
    return;
  }

  const repoPath = path.resolve(values.repo as string);
  if (!existsSync(repoPath)) {
    console.error(c.red(`error: repo path does not exist: ${repoPath}`));
    process.exitCode = 2;
    return;
  }

  const json = values.json === true;
  const logger = pino({ level: values.verbose ? "info" : "silent" }, process.stderr);
  const registry = createRegistry([
    new ClaudeAdapter(),
    new CodexAdapter(),
    new AntigravityAdapter(),
  ]);
  const capacitySnapshots = mode === "team" && values["capacity-routing"]
    ? readRoutingCapacity(values, capacityTiming)
    : undefined;

  // Cancellation: first Ctrl+C aborts the run; a second forces exit.
  const ac = new AbortController();
  let cancelling = false;
  process.on("SIGINT", () => {
    if (cancelling) {
      console.error(c.red("\nforce exit"));
      process.exit(130);
    }
    cancelling = true;
    console.error(c.yellow("\n⚠ cancelling run (Ctrl+C again to force)…"));
    ac.abort();
  });

  const teamHooks: RunBremioHooks = json
    ? {}
    : {
        onLeadStart: (id) =>
          console.log(`${c.bold("●")} Lead ${c.cyan(id)} is analyzing the repo and planning…`),
        onLeadEvent: (ev) => {
          const l = compactEvent(ev);
          if (l) console.log(l);
        },
        onPlan: (plan, assign) => printPlan(plan, assign),
        onTaskStart: (task, agentId) =>
          console.log(`\n${c.bold("▶")} ${c.cyan(task.id)} ${task.title} ${c.bold(`→ ${agentId}`)}`),
        // Tasks run concurrently by default, so every streamed line and every
        // completion is tagged — otherwise interleaved output is unreadable.
        onEvent: (task, _agentId, ev) => {
          const l = compactEvent(ev);
          if (l) console.log(`${c.dim(`[${task.id}]`)} ${l}`);
        },
        onTaskComplete: (r) =>
          console.log(
            `  ${statusGlyph(r.status)} ${c.cyan(r.taskId)} ${c.dim(`(${r.filesChanged.length} file(s), ${Math.round((r.durationMs ?? 0) / 1000)}s)`)}`,
          ),
      };

  const singleHooks: SingleRunHooks = json
    ? {}
    : {
        onWorkspaceReady: (dirtyFiles) => {
          if (dirtyFiles.length === 0) return;
          console.error(
            c.yellow(
              `warning: Single mode will use the current workspace with ${dirtyFiles.length} pre-existing dirty file(s)`,
            ),
          );
          for (const file of dirtyFiles.slice(0, 10)) console.error(c.yellow(`  - ${file}`));
          if (dirtyFiles.length > 10) {
            console.error(c.yellow(`  - ...and ${dirtyFiles.length - 10} more`));
          }
        },
        onStart: (id) =>
          console.log(
            `${c.bold("●")} Single Agent ${c.cyan(id)} is working directly in ${c.dim(repoPath)}…`,
          ),
        onEvent: (event) => {
          const line = compactEvent(event);
          if (line) console.log(line);
        },
        onComplete: (result) =>
          console.log(
            `  ${statusGlyph(result.status)} ${c.dim(`(${result.filesChanged.length} file(s), ${Math.round(result.durationMs / 1000)}s)`)}`,
          ),
      };

  try {
    if (mode === "single") {
      const report = await runSingleAgent({
        primaryAgentId: values.agent as string,
        repoPath,
        prompt,
        registry,
        signal: ac.signal,
        hooks: singleHooks,
        ...(values.model ? { model: values.model } : {}),
        ...(values.reasoning
          ? { reasoningLevel: values.reasoning as ReasoningLevel }
          : {}),
        ...(timeoutSeconds !== undefined ? { timeoutMs: Math.round(timeoutSeconds * 1000) } : {}),
        ...(values.comparison ? { comparisonId: values.comparison.trim() } : {}),
      });

      if (json) console.log(JSON.stringify(report, null, 2));
      else printReport(report);
      process.exitCode = report.result.status === "completed" ? 0 : 1;
      return;
    }

    const report = await runBremio({
      leadId: values.lead as "claude" | "codex",
      ...(values.worker ? { workerId: values.worker } : {}),
      repoPath,
      prompt,
      registry,
      logger,
      signal: ac.signal,
      hooks: teamHooks,
      ...(values.model ? { model: values.model } : {}),
      ...(values.reasoning
        ? { reasoningLevel: values.reasoning as ReasoningLevel }
        : {}),
      ...(timeoutSeconds !== undefined ? { taskTimeoutMs: Math.round(timeoutSeconds * 1000) } : {}),
      ...(concurrency !== undefined ? { maxConcurrency: concurrency } : {}),
      ...(capacitySnapshots ? { capacitySnapshots } : {}),
      ...(values.comparison ? { comparisonId: values.comparison.trim() } : {}),
    });

    if (json) console.log(JSON.stringify(report, null, 2));
    else printReport(report);

    process.exitCode =
      report.summary.failed > 0 ||
      report.tasks.length === 0 ||
      report.qualityGate.status !== "passed"
        ? 1
        : 0;
  } catch (err) {
    if (err instanceof PlanValidationError) {
      console.error(c.red("\nPlan validation failed:"));
      for (const e of err.errors) console.error(c.red(`  - ${e}`));
    } else if (err instanceof LeadPlanError) {
      console.error(c.red(`\n${err.message}`));
    } else {
      console.error(c.red(`\nBremio failed: ${(err as Error).message}`));
      if (values.verbose) console.error((err as Error).stack);
    }
    process.exitCode = 1;
  }
}

function resolveRepo(values: Values): string | undefined {
  const repoPath = path.resolve(values.repo ?? ".");
  if (!existsSync(repoPath)) {
    console.error(c.red(`error: repo path does not exist: ${repoPath}`));
    return undefined;
  }
  return repoPath;
}

async function mergeCommandFromCli(values: Values, positionals: string[]): Promise<number> {
  const repoPath = resolveRepo(values);
  if (!repoPath) return 2;
  const taskId = positionals[1];
  if (!taskId && !values.run) {
    console.error(c.red("error: specify a <taskId> or --run <runId>"));
    console.log(`\n${USAGE}`);
    return 2;
  }
  if (values.strategy !== undefined && values.strategy !== "merge" && values.strategy !== "cherry-pick") {
    console.error(c.red("error: --strategy must be 'merge' or 'cherry-pick'"));
    return 2;
  }
  return mergeCommand({
    repoPath,
    assumeYes: values.yes === true,
    ...(taskId ? { taskId } : {}),
    ...(values.run ? { runId: values.run } : {}),
    ...(values.base ? { base: values.base } : {}),
    ...(values.strategy ? { strategy: values.strategy as "merge" | "cherry-pick" } : {}),
  });
}

async function statsCommandFromCli(values: Values): Promise<number> {
  const repoPath = resolveRepo(values);
  if (!repoPath) return 2;
  let since: Date | undefined;
  if (values.since) {
    since = new Date(values.since);
    if (Number.isNaN(since.getTime())) {
      console.error(c.red(`error: invalid --since date: ${values.since}`));
      return 2;
    }
  }
  return statsCommand({ repoPath, ...(since ? { since } : {}) });
}

async function quotaCommandFromCli(values: Values): Promise<number> {
  const timing = parseCapacityTiming(values);
  if (timing.error) {
    console.error(c.red(`error: ${timing.error}`));
    return 2;
  }
  return capacityCommand({
    refresh: values["no-refresh"] !== true,
    ...(values.db ? { databasePath: path.resolve(values.db) } : {}),
    ...(timing.staleAfterSeconds !== undefined
      ? { staleAfterSeconds: timing.staleAfterSeconds }
      : {}),
    ...(timing.agingAfterSeconds !== undefined
      ? { agingAfterSeconds: timing.agingAfterSeconds }
      : {}),
  });
}

interface CapacityTiming {
  agingAfterSeconds?: number;
  staleAfterSeconds?: number;
  error?: string;
}

function parseCapacityTiming(values: Values): CapacityTiming {
  const agingMinutes = values["aging-after"] === undefined
    ? undefined
    : Number(values["aging-after"]);
  const staleMinutes = values["stale-after"] === undefined
    ? undefined
    : Number(values["stale-after"]);
  if (staleMinutes !== undefined && (!Number.isFinite(staleMinutes) || staleMinutes <= 0)) {
    return { error: "--stale-after must be a positive number of minutes" };
  }
  if (agingMinutes !== undefined && (!Number.isFinite(agingMinutes) || agingMinutes <= 0)) {
    return { error: "--aging-after must be a positive number of minutes" };
  }
  const effectiveStaleMinutes = staleMinutes ?? DEFAULT_STALE_AFTER_SECONDS / 60;
  if (agingMinutes !== undefined && agingMinutes >= effectiveStaleMinutes) {
    return { error: "--aging-after must be less than --stale-after" };
  }
  return {
    ...(agingMinutes !== undefined ? { agingAfterSeconds: agingMinutes * 60 } : {}),
    ...(staleMinutes !== undefined ? { staleAfterSeconds: staleMinutes * 60 } : {}),
  };
}

function readRoutingCapacity(
  values: Values,
  timing: CapacityTiming,
): AgentCapacitySnapshot[] {
  const databasePath = values.db ? path.resolve(values.db) : defaultAqtDatabasePath();
  if (!databasePath || !existsSync(databasePath)) {
    console.error(c.yellow("warning: capacity routing has no AQT database; quota stays unknown"));
    return [];
  }
  try {
    const source = readAqtQuota({
      databasePath,
      staleAfterSeconds: timing.staleAfterSeconds ?? DEFAULT_STALE_AFTER_SECONDS,
    });
    const snapshots = toAqtCapacitySnapshots(source, {
      ...(timing.agingAfterSeconds !== undefined
        ? { agingAfterSeconds: timing.agingAfterSeconds }
        : {}),
    });
    // Mirror what the router actually trusts: a fresh, high-confidence WINDOW.
    // Contact freshness is irrelevant here — a reachable source whose windows
    // are all stale still leaves routing conservative.
    const anyTrustedWindow = snapshots.some((snapshot) =>
      snapshot.windows.some(
        (window) => window.freshness === "fresh" && window.confidence === "high",
      ));
    if (!anyTrustedWindow) {
      console.error(
        c.yellow("warning: no AQT capacity window is fresh and high-confidence; routing stays conservative"),
      );
    }
    return snapshots;
  } catch (error) {
    console.error(
      c.yellow(`warning: capacity routing could not read AQT; quota stays unknown: ${(error as Error).message}`),
    );
    return [];
  }
}

/**
 * Daemon lifecycle. `bremio daemon` with no subcommand keeps running it in the
 * foreground, which is what the VS Code extension spawns.
 */
async function daemonCommandFromCli(subcommand?: string): Promise<number> {
  switch (subcommand ?? "start") {
    case "start":
      return runDaemonForeground();
    case "status":
      return reportDaemonStatus();
    case "stop":
      return stopDaemonCommand();
    case "restart":
      await stopDaemonCommand();
      return runDaemonForeground();
    default:
      console.error(c.red(`unknown daemon subcommand: ${subcommand}`));
      console.error(c.dim("  expected one of: start, status, stop, restart"));
      return 2;
  }
}

async function runDaemonForeground(): Promise<number> {
  let daemon: Awaited<ReturnType<typeof startDaemon>>;
  try {
    daemon = await startDaemon({ version: VERSION });
  } catch (err) {
    if (err instanceof DaemonAlreadyRunningError) {
      console.error(c.yellow(`error: ${err.message}`));
      if (err.existing) {
        console.error(c.dim(`  already listening on 127.0.0.1:${err.existing.port} (pid ${err.existing.pid})`));
      }
      console.error(c.dim("  run: bremio daemon status   (or: bremio daemon restart)"));
      return 1;
    }
    throw err;
  }

  console.log(`${c.bold("Bremio daemon")} listening on ${c.cyan(`127.0.0.1:${daemon.port}`)}`);
  console.log(c.dim(`  endpoint: ${daemon.endpointFile}`));
  if (daemon.reconciled.length > 0) {
    console.log(
      c.yellow(`  ${daemon.reconciled.length} run(s) marked interrupted from a previous session`),
    );
  }
  console.log(c.dim("  press Ctrl+C to stop"));

  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void daemon.close().then(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  await new Promise(() => {}); // hold the process open until a signal arrives
  return 0;
}

async function reportDaemonStatus(): Promise<number> {
  const status = await daemonStatus();
  if (status.running) {
    console.log(`${c.green("running")} — 127.0.0.1:${status.endpoint.port} (pid ${status.endpoint.pid})`);
    console.log(c.dim(`  version ${status.endpoint.daemonVersion} · protocol ${status.endpoint.protocolVersion}`));
    console.log(c.dim(`  started ${status.endpoint.startedAt}`));
    return 0;
  }
  console.log(`${c.yellow("not running")} — ${status.detail}`);
  return status.staleEndpoint ? 1 : 0;
}

async function stopDaemonCommand(): Promise<number> {
  const outcome = await stopDaemon();
  console.log(outcome.stopped ? c.green(outcome.detail) : c.dim(outcome.detail));
  return 0;
}

/**
 * Explain how to update rather than doing it.
 *
 * Self-updating a globally installed CLI means rewriting the binary that is
 * currently executing, and getting it wrong leaves the user with no working
 * install at all. Printing the exact command is honest and cannot break
 * anything; a real updater can come once there is a published registry
 * artifact to update from.
 */
function updateCommand(): void {
  console.log(`${c.bold("Bremio")} ${VERSION}\n`);
  console.log("Bremio does not update itself. To update:\n");
  console.log(`  ${c.cyan("npm i -g bremio")}                 update the CLI (and the bundled daemon)`);
  console.log(`  ${c.cyan("bremio daemon restart")}           pick up the new daemon`);
  console.log(`  ${c.dim("Extensions view → Bremio")}         update the VS Code extension\n`);
  console.log(c.dim("This alpha ships as a local tarball, so install from the artifact you built:"));
  console.log(c.dim(`  npm i -g ./bremio-${VERSION}.tgz\n`));
  console.log(
    `Check what you are running with ${c.cyan("bremio doctor")} or ${c.cyan("bremio daemon status")}.`,
  );
}

async function doctor(): Promise<void> {
  console.log(c.bold("bremio doctor — adapter health\n"));
  for (const adapter of [
    new ClaudeAdapter(),
    new CodexAdapter(),
    new AntigravityAdapter(),
  ]) {
    const health = await adapter.healthCheck();
    const caps = await adapter.getCapabilities();
    const glyph =
      health.status === "ok"
        ? c.green("ok")
        : health.status === "degraded"
          ? c.yellow("degraded")
          : c.red("unavailable");
    console.log(`  ${adapter.id.padEnd(8)} ${glyph}   ${c.dim(health.detail ?? "")}`);
    console.log(
      c.dim(
        `           lead-eligible: ${caps.planning && caps.structuredOutput ? "yes" : "no"}  ` +
          `(planning=${caps.planning}, structuredOutput=${caps.structuredOutput})`,
      ),
    );
  }
}

main().catch((err) => {
  console.error(c.red(`fatal: ${(err as Error).message}`));
  process.exit(1);
});
