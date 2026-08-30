import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { pino } from "pino";
import {
  LeadPlanError,
  PlanValidationError,
  evaluateCalibrationReadiness,
  ledgerPathFor,
  readLedger,
  resolveAutoMode,
  runBremio,
  runSingleAgent,
  shouldEscalate,
  resolveEscalationApproval,
  type RunBremioHooks,
  type SingleRunHooks,
} from "@bremio/orchestrator";
import { executionToCollaboration, validateCombination, type WorkspaceStrategy } from "@bremio/policy";
import { ExecutionModeSchema, type ReasoningLevel, type TaskStatus } from "@bremio/protocol";
import {
  DEFAULT_STALE_AFTER_SECONDS,
  defaultAqtDatabasePath,
  readAqtQuota,
  toAqtCapacitySnapshots,
  type AgentCapacitySnapshot,
} from "@bremio/quota";
import {
  DaemonAlreadyRunningError,
  startDaemon,
  stopDaemon,
} from "@bremio/daemon";
import {
  DaemonClient,
  DaemonUnavailableError,
  ProtocolMismatchError,
  type RunEvent,
} from "@bremio/daemon-client";
import { applyCommand } from "./apply";
import { mergeCommand } from "./merge";
import { collectDiagnostics, exportDiagnostics, redactDeep } from "./diagnostics";
import { collectComparison, printComparison, type ComparisonSide } from "./compare";
import { capacityCommand } from "./quota";
import { compareCommandFromCli } from "./compare";
import { mcpCommandFromCli } from "./mcp";
import { sessionCommandFromCli } from "./session";
import { statsCommand } from "./stats";
import { memoryCommandFromCli } from "./memory";
import { runInfoCommandFromCli } from "./run-info";
import { canUseTui, startTui } from "./tui";
import { createCLIPluginManager, KNOWN_ADAPTER_IDS } from "./tui/data";
import { renderEvent } from "@bremio/event-view";
import { c, formatEventView, printPlan, printReport, renderRunEvent, statusGlyph, tagStandalone } from "./ui";
import { runViaEphemeralDaemon } from "./ephemeral";

declare const __BREMIO_VERSION__: string | undefined;
const VERSION = typeof __BREMIO_VERSION__ === "string"
  ? __BREMIO_VERSION__
  : process.env.npm_package_version ?? "dev";

const USAGE = `${c.bold("bremio")} — provider-agnostic orchestrator for AI coding agents

${c.bold("Usage")}
  bremio                                  launch the interactive TUI (needs a terminal)
  bremio tui [--repo <path>]              same, explicitly
  bremio run --mode single --agent <agent> --repo <path> "<prompt>"
  bremio run --mode team --lead <agent> [--worker <agent>] --repo <path> "<prompt>"
  bremio compare [--agent <agent>] [--lead <agent>] --repo <path> "<prompt>"
  bremio session list [--repo <path>] [--json]
  bremio session show <id> [--json] [--max-events <n>]
  bremio session config-set <id> [--mode single|team] [--model <str>] [--reason <str>]
  bremio merge <taskId> [--run <runId>] [--strategy <merge|cherry-pick>] [--yes]
  bremio stats [--since <date>] [--repo <path>]
  bremio capacity [--db <path>] [--aging-after <minutes>] [--stale-after <minutes>] [--open-usage <agent>]
  bremio quota [--db <path>] [--aging-after <minutes>] [--stale-after <minutes>] [--open-usage <agent>]
  bremio daemon [start|status|stop|restart]   manage the local daemon (HTTP + SSE, loopback)
  bremio mcp discover  --manifest <file>      list tools from MCP servers
  bremio update                           how to update the CLI, daemon and extension
  bremio doctor [--json]                  adapter health; --json for a support bundle
  bremio diagnostics export [--out <f>]   write a redacted diagnostics bundle
  bremio --version
  bremio --help

${c.bold("run")}      run one agent directly or orchestrate an isolated team
  --mode <single|team|auto> Explicit execution mode (auto uses calibration evidence). Required for new commands.
  --agent <agent>         Agent for Single mode: claude, codex, antigravity, or opencode.
  --lead <agent>          Lead for Team mode (distributes sub-tasks).
  --worker <agent>        Available workers for Team mode (can be passed multiple times).

${c.bold("run-info")} show run artifacts and blackboard context
    Usage: bremio run-info <runId> <context|artifacts>
    --repo <path>           Target git repository. Required.
  --model <id>            Model for the Single agent or Team lead (optional).
  --reasoning <level>     Single-agent or Team-lead reasoning level.
  --timeout <seconds>     Hard timeout for the Single run or each Team task.
  --concurrency <n>       Team tasks to run at once (default: 2, dependency-safe).
  --capacity-routing      Opt in to conservative Team capacity routing.
  --db <path>             Override the AQT database used for capacity routing.
  --comparison <id>       Link this run to a controlled Single/Team experiment.
  --escalate              Auto-approve escalation to Team when Single fails verification.
  --json                  Print the report as JSON (suppresses progress).
  --standalone            Run in-process, not through the daemon; run is
                          not visible in the shared panel.
  --verbose               Emit structured operational logs to stderr.

${c.bold("compare")}  collect a controlled Single-vs-Team calibration pair
  --repo <path>           Clean target git repository. Required.
  Single changes run in a disposable worktree; only their evidence is retained.
  --agent <agent>         Single baseline provider (default: claude).
  --lead <agent>          Team lead provider (default: claude).
  --worker <agent>        Explicit Team worker; must differ from the lead.
  --reasoning <level>     Reasoning level for Single and Team lead.
  --timeout <seconds>     Hard timeout for Single and each Team task.
  --concurrency <n>       Team tasks to run at once (default: 2).

${c.bold("merge")}    review a completed task's diff, then merge it into the base branch
  <taskId>                The task to merge (e.g. TASK-002).
  --run <runId>           Merge every task in a run (or disambiguate a taskId).
  --repo <path>           Repo to look in (default: current directory).
  --base <branch>         Override the merge target (default: run's base branch).
  --strategy <mode>       Integrate task branches with merge (default) or cherry-pick.
  --yes                   Skip the confirmation prompt.

${c.bold("apply")}    apply a run's changes to the working tree (per task or per file)
  <runId>                 The run whose changes to apply.
  --task <taskId>         Apply only this task's changes (Team runs).
  --file <path>           Apply only one file's changes.
  --force                 Overwrite conflicting user edits in the working tree.
  --repo <path>           Repo to look in (default: current directory).

${c.bold("revert")}   revert a run's changes from the working tree (per task or per file)
  <runId>                 The run whose changes to revert.
  --task <taskId>         Revert only this task's changes (Team runs).
  --file <path>           Revert only one file's changes.
  --force                 Overwrite conflicting user edits in the working tree.
  --repo <path>           Repo to look in (default: current directory).

${c.bold("stats")}    summarize the usage ledger (.bremio/ledger.jsonl)
  --since <date>          Only count tasks on/after this date (e.g. 2026-07-01).
  --repo <path>           Repo to look in (default: current directory).

${c.bold("capacity")} show canonical agent capacity from AI-Quota-Tray's SQLite database
${c.bold("quota")}    backward-compatible alias for capacity
  --db <path>             Override the default AI-Quota-Tray database path.
  --no-refresh            Read last-known data without asking AQT to fetch.
  --aging-after <minutes> Degrade source confidence after this age (default: 15).
  --stale-after <minutes> Treat older snapshots as unknown (default: 30).
  --open-usage <agent>    Open the agent's native usage page (codex, claude).`;

function parseCli() {
  return parseArgs({
    allowPositionals: true,
    options: {
      mode: { type: "string" },
      agent: { type: "string" },
      lead: { type: "string" },
      worker: { type: "string", multiple: true },
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
      "open-usage": { type: "string" },
      out: { type: "string" },
      comparison: { type: "string" },
      "workspace-strategy": { type: "string" },
      "workspace": { type: "string" },
      session: { type: "string" },
      turn: { type: "string" },
      reason: { type: "string" },
      "lead-agent": { type: "string" },
      "worker-agent": { type: "string" },
      "reasoning-level": { type: "string" },
      permission: { type: "string" },
      "approval-mode": { type: "string" },
      cwd: { type: "string" },
      "base-branch": { type: "string" },
      "collaboration-state": { type: "string" },
      "changed-by": { type: "string" },
      scope: { type: "string" },
      ttl: { type: "string" },
      "action-class": { type: "string" },
      target: { type: "string" },
      precedence: { type: "string" },
      state: { type: "string" },
      "decided-by": { type: "string" },
      isolated: { type: "boolean", default: false },
      escalate: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      standalone: { type: "boolean", default: false },
      verbose: { type: "boolean", default: false },
      task: { type: "string" },
      file: { type: "string" },
      force: { type: "boolean", default: false },
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
    case "run-info":
      process.exitCode = await runInfoCommandFromCli(positionals, repoPath);
      return;
    case "compare":
      process.exitCode = await compareCommandFromCli(values, positionals);
      return;
    case "memory":
      process.exitCode = await memoryCommandFromCli(values, positionals);
      return;
    case "session":
      process.exitCode = await sessionCommandFromCli(values, positionals);
      return;
    case "merge":
      process.exitCode = await mergeCommandFromCli(values, positionals);
      return;
    case "apply":
    case "revert":
      process.exitCode = await applyCommandFromCli(values, positionals, command);
      return;
    case "stats":
      process.exitCode = await statsCommand(values);
      return;
    case "capacity":
    case "quota":
      process.exitCode = await quotaCommandFromCli(values);
      return;
    case "approval":
      process.exitCode = await approvalCommandFromCli(values, positionals);
      return;
    case "mcp":
      process.exitCode = await mcpCommandFromCli(values, positionals);
      return;
    case "daemon":
      process.exitCode = await daemonCommandFromCli(positionals[1]);
      return;
    case "update":
      updateCommand();
      return;
    case "doctor":
      process.exitCode = await doctorCommand(values);
      return;
    case "diagnostics":
      process.exitCode = await diagnosticsCommand(values, positionals[1]);
      return;
    default:
      console.error(c.red(`unknown command: ${command}`));
      console.log(USAGE);
      process.exitCode = 2;
  }
}

async function compareCommandFromCli(values: Values, positionals: string[]): Promise<number> {
  const prompt = (values.prompt ?? positionals.slice(1).join(" ")).trim();
  const agentIds = KNOWN_ADAPTER_IDS;
  const singleAgentId = values.agent ?? "claude";
  const teamLeadId = values.lead ?? "claude";
  const errors: string[] = [];
  if (!values.repo) errors.push("--repo <path> is required");
  if (!prompt) errors.push('a prompt is required, e.g. bremio compare --repo . "add a health endpoint"');
  if (!agentIds.has(singleAgentId)) {
    errors.push(`--agent must be a known agent id: ${[...agentIds].sort().join(", ")}`);
  }
  if (!agentIds.has(teamLeadId)) {
    errors.push(`--lead must be a known agent id: ${[...agentIds].sort().join(", ")}`);
  }
  const workers = values.worker
    ? (Array.isArray(values.worker) ? values.worker : [values.worker])
    : [];
  for (const w of workers) {
    if (!agentIds.has(w)) {
      errors.push(`--worker must be a known agent id: ${[...agentIds].sort().join(", ")}`);
    }
    if (w === teamLeadId) errors.push("--worker must be different from --lead");
  }
  if (values.mode !== undefined) errors.push("compare generates both modes; do not pass --mode");
  if (values.comparison !== undefined) {
    errors.push("compare generates its own shared comparison id; do not pass --comparison");
  }
  if (values["capacity-routing"]) {
    errors.push("--capacity-routing is not supported by controlled comparisons");
  }
  const timeoutSeconds = values.timeout === undefined ? undefined : Number(values.timeout);
  if (timeoutSeconds !== undefined && (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0)) {
    errors.push("--timeout must be a positive number of seconds");
  }
  const concurrency = values.concurrency === undefined ? undefined : Number(values.concurrency);
  if (concurrency !== undefined && (!Number.isInteger(concurrency) || concurrency < 1)) {
    errors.push("--concurrency must be a positive whole number of tasks");
  }
  const reasoningLevels = new Set<ReasoningLevel>(["low", "medium", "high", "xhigh"]);
  if (values.reasoning && !reasoningLevels.has(values.reasoning as ReasoningLevel)) {
    errors.push("--reasoning must be 'low', 'medium', 'high', or 'xhigh'");
  }
  if (errors.length > 0) {
    for (const error of errors) console.error(c.red(`error: ${error}`));
    console.log(`\n${USAGE}`);
    return 2;
  }

  const repoPath = path.resolve(values.repo as string);
  if (!existsSync(repoPath)) {
    console.error(c.red(`error: repo path does not exist: ${repoPath}`));
    return 2;
  }

  const json = values.json === true;
  const pluginManager = await createCLIPluginManager();
  const registry = pluginManager.getRegistry();
  const logger = pino({ level: values.verbose ? "info" : "silent" }, process.stderr);
  const singleController = new AbortController();
  const teamController = new AbortController();
  let activeSide: ComparisonSide | undefined;
  let cancelling = false;
  const onInterrupt = () => {
    if (!activeSide) return;
    if (cancelling) {
      console.error(c.red("\nforce exit"));
      process.exit(130);
    }
    cancelling = true;
    console.error(c.yellow(`\n⚠ cancelling ${activeSide} side (Ctrl+C again to force)…`));
    (activeSide === "single" ? singleController : teamController).abort();
  };
  process.on("SIGINT", onInterrupt);

  try {
    const result = await collectComparison({
      repoPath,
      prompt,
      registry,
      singleAgentId,
      teamLeadId,
      ...(values.worker ? { teamWorkerId: Array.isArray(values.worker) ? values.worker[0] : values.worker } : {}),
      ...(values.model ? { model: values.model } : {}),
      ...(values.reasoning
        ? { reasoningLevel: values.reasoning as ReasoningLevel }
        : {}),
      ...(timeoutSeconds !== undefined ? { timeoutMs: Math.round(timeoutSeconds * 1000) } : {}),
      ...(concurrency !== undefined ? { maxConcurrency: concurrency } : {}),
      singleSignal: singleController.signal,
      teamSignal: teamController.signal,
      logger,
      hooks: {
        onSideStart: (side) => {
          activeSide = side;
          cancelling = false;
          if (!json) console.log(`\n${c.bold(side === "single" ? "Single baseline" : "Team flow")}`);
        },
        single: json
          ? {}
          : {
              onStart: (id) => console.log(`${c.bold("●")} ${c.cyan(id)} is running in an isolated baseline worktree…`),
              onEvent: (event) => {
                console.log(formatEventView(renderEvent(event)));
              },
            },
        team: json
          ? {}
          : {
              onLeadStart: (id) => console.log(`${c.bold("●")} Lead ${c.cyan(id)} is planning…`),
              onLeadEvent: (event) => {
                console.log(formatEventView(renderEvent(event)));
              },
              onPlan: (plan, assign) => printPlan(plan, assign),
              onTaskStart: (task, id) =>
                console.log(`\n${c.bold("▶")} ${c.cyan(task.id)} ${task.title} ${c.bold(`→ ${id}`)}`),
              onEvent: (task, _id, event) => {
                console.log(`${c.dim(`[${task.id}]`)} ${formatEventView(renderEvent(event))}`);
              },
              onTaskComplete: (taskResult) =>
                console.log(`  ${statusGlyph(taskResult.status)} ${c.cyan(taskResult.taskId)}`),
            },
      },
    });
    activeSide = undefined;
    if (json) console.log(JSON.stringify(result, null, 2));
    else printComparison(result);
    return result.single.verification.status === "passed" &&
        result.team.qualityGate.status === "passed"
      ? 0
      : 1;
  } catch (error) {
    console.error(c.red(`\nComparison failed: ${(error as Error).message}`));
    if (values.verbose) console.error((error as Error).stack);
    return 1;
  } finally {
    process.off("SIGINT", onInterrupt);
  }
}

async function runViaDaemon(values: Values, prompt: string, mode: "single" | "team", json: boolean): Promise<boolean> {
  const client = new DaemonClient();
  try {
    await client.connect();
  } catch {
    return false;
  }

  const repoPath = path.resolve(values.repo as string);
  const workers = values.worker
    ? (Array.isArray(values.worker) ? values.worker : [values.worker])
    : [];
  const request = {
    mode,
    repoPath,
    prompt,
    agentId: (mode === "single" ? values.agent : values.lead) as string,
    ...(workers.length > 0 ? { workerIds: workers } : {}),
    ...(values.model ? { model: values.model } : {}),
    ...(values.reasoning ? { reasoningLevel: values.reasoning as string } : {}),
    ...(values.timeout !== undefined ? { timeoutMs: Math.round(Number(values.timeout) * 1000) } : {}),
    ...(values.concurrency !== undefined ? { maxConcurrency: Number(values.concurrency) } : {}),
    ...(values.comparison ? { comparisonId: values.comparison.trim() } : {}),
    ...(values["workspace-strategy"]
      ? { workspaceStrategy: values["workspace-strategy"] as "direct-workspace" | "isolated-worktree" }
      : values.isolated ? { workspaceStrategy: "isolated-worktree" as const } : {}),
  };

  const ac = new AbortController();
  let cancelling = false;
  let runId: string | undefined;
  const collectedEvents: RunEvent[] = [];

  const onInt = () => {
    if (cancelling) {
      console.error(c.red("\nforce exit"));
      process.exit(130);
    }
    cancelling = true;
    console.error(c.yellow("\n⚠ cancelling run (Ctrl+C again to force)…"));
    ac.abort();
    if (runId) client.cancelRun(runId).catch(() => {});
  };

  process.on("SIGINT", onInt);

  try {
    const { run } = await client.startRun(request);
    runId = run.id;
    if (!json) console.log(c.dim(`run started via daemon (id: ${runId})`));

    await client.streamEvents(runId, (event) => {
      if (json) {
        collectedEvents.push(event);
        return;
      }
      console.log(renderRunEvent(event));
    }, ac.signal);
  } catch (err) {
    if (!ac.signal.aborted) {
      console.error(c.red(`\ndaemon run failed: ${(err as Error).message}`));
      return true;
    }
    // Aborted due to cancellation — stream stop is expected
  } finally {
    process.off("SIGINT", onInt);
  }

  // Post-stream: show run summary
  if (runId) {
    try {
      const detail = await client.runDetail(runId, repoPath);
      if (json) {
        console.log(JSON.stringify({ run: detail.run, events: collectedEvents }, null, 2));
      } else if (detail.run?.status) {
        const glyph = statusGlyph(detail.run.status as TaskStatus);
        const events = detail.events;
        const fileCount = events?.filter((e) => e.kind === "task-complete").length ?? 0;
        console.log(`  ${glyph} ${c.dim(`${fileCount > 0 ? `${fileCount} file(s), ` : ""}run: ${detail.run.id}`)}`);
      }
    } catch {
      // best-effort; the daemon might have shut down already
    }
  }

  return true;
}

async function runCommand(values: Values, positionals: string[]): Promise<void> {
  const prompt = (values.prompt ?? positionals.slice(1).join(" ")).trim();
  const errors: string[] = [];
  const CLI_MODES = new Set(["single", "team", "auto"]);
  const rawMode = values.mode ?? (values.lead ? "team" : undefined);
  const isAuto = rawMode === "auto";

  // Parse the execution mode. Auto is handled at the CLI level and resolved
  // to single/team before reaching orchestrator code.
  if (rawMode && !CLI_MODES.has(rawMode)) {
    errors.push("--mode must be 'single', 'team', or 'auto'");
  }
  let mode: "single" | "team" | undefined;
  let autoReason: string | undefined;
  if (isAuto) {
    mode = undefined; // resolved later after repo path is known
  } else {
    const parsedMode = ExecutionModeSchema.safeParse(rawMode);
    mode = parsedMode.success ? parsedMode.data : undefined;
    if (rawMode && rawMode !== "auto" && !parsedMode.success) {
      errors.push("--mode must be 'single' or 'team'");
    }
  }
  const agentIds = KNOWN_ADAPTER_IDS;
  if (mode === "single" && !agentIds.has(values.agent ?? "")) {
    errors.push("Single mode requires --agent 'claude', 'codex', 'antigravity', or 'opencode'");
  }
  if (mode === "team" && !agentIds.has(values.lead ?? "")) {
    errors.push(`--lead must be a known agent id: ${[...agentIds].sort().join(", ")}`);
  }
  if (mode === "single" && values.lead) {
    errors.push("--lead is only valid in Team mode; use --agent for Single mode");
  }
  const runWorkers = values.worker
    ? (Array.isArray(values.worker) ? values.worker : [values.worker])
    : [];
  if (mode === "single" && runWorkers.length > 0) {
    errors.push("--worker is only valid in Team mode");
  }
  if (mode === "team" && runWorkers.length > 0) {
    for (const w of runWorkers) {
      if (!agentIds.has(w)) {
        errors.push("--worker must be 'claude', 'codex', 'antigravity', or 'opencode'");
      }
      if (w === values.lead) {
        errors.push("--worker must be different from --lead");
      }
    }
  }
  if (mode === "team" && values.agent) {
    errors.push("--agent is only valid in Single mode; use --lead for Team mode");
  }
  if (mode === "single" && values["capacity-routing"]) {
    errors.push("--capacity-routing is only valid in Team mode");
  }
  if (isAuto && values["capacity-routing"]) {
    errors.push("--capacity-routing requires explicit --mode team");
  }
  if (isAuto && values.agent && values.lead) {
    errors.push("auto mode does not accept both --agent and --lead; let auto choose");
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
  if (concurrency !== undefined && (mode === "single" || isAuto)) {
    errors.push("--concurrency is only valid in Team mode");
  }
  const reasoningLevels = new Set<ReasoningLevel>(["low", "medium", "high", "xhigh"]);
  if (values.reasoning && !reasoningLevels.has(values.reasoning as ReasoningLevel)) {
    errors.push("--reasoning must be 'low', 'medium', 'high', or 'xhigh'");
  }
  if (values.comparison !== undefined && values.comparison.trim().length === 0) {
    errors.push("--comparison must be a non-empty experiment id");
  }
  let workspaceStrategy: WorkspaceStrategy = "direct-workspace";
  if (values.isolated || values["workspace-strategy"] === "isolated-worktree") {
    workspaceStrategy = "isolated-worktree";
  } else if (values["workspace-strategy"] === "direct-workspace") {
    workspaceStrategy = "direct-workspace";
  } else if (values["workspace-strategy"]) {
    errors.push("--workspace-strategy must be 'direct-workspace' or 'isolated-worktree'");
  }

  if (mode) {
    const validation = validateCombination(executionToCollaboration(mode), "autopilot", workspaceStrategy);
    if (!validation.valid) {
      errors.push(validation.reason ?? "Invalid combination of mode and workspace strategy");
    }
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

  // Resolve auto mode from ledger evidence.
  if (isAuto) {
    const ledgerPath = ledgerPathFor(repoPath);
    const ledgerEntries = await readLedger(ledgerPath);
    const result = resolveAutoMode(ledgerEntries);
    mode = result.mode;
    autoReason = result.reason;
    console.log(c.dim(`  auto: ${autoReason}`));
    // Use user-specified agent/lead when given; otherwise default to Claude.
    if (mode === "single" && !values.agent) {
      values.agent = "claude";
    }
    if (mode === "team" && !values.lead) {
      values.lead = "claude";
    }
    // Re-check worker validation now that the resolved mode is known.
    if (mode === "team" && runWorkers.length > 0) {
      for (const w of runWorkers) {
        if (!agentIds.has(w)) {
          console.error(c.red(`error: --worker must be 'claude', 'codex', 'antigravity', or 'opencode'`));
          process.exitCode = 2;
          return;
        }
        if (w === values.lead) {
          console.error(c.red("error: --worker must be different from --lead"));
          process.exitCode = 2;
          return;
        }
      }
    }
    if (mode === "single" && runWorkers.length > 0) {
      console.error(c.red("error: --worker is only valid in Team mode"));
      process.exitCode = 2;
      return;
    }
    if (mode === "single" && values.lead) {
      console.error(c.red("error: --lead is only valid in Team mode; use --agent for Single mode"));
      process.exitCode = 2;
      return;
    }
    if (mode === "team" && values.agent) {
      console.error(c.red("error: --agent is only valid in Single mode; use --lead for Team mode"));
      process.exitCode = 2;
      return;
    }
  }

  // S4-T5: try the persistent daemon first; if unavailable, start an ephemeral
  // daemon in-process (same protocol, no 2nd implementation — docs/15 §5).
  // Only --standalone skips both and runs in-process directly.
  const json = values.json === true;
  if (!values.standalone) {
    if (mode && await runViaDaemon(values, prompt, mode, json)) return;
    if (mode && await runViaEphemeralDaemon({
      mode,
      repoPath: path.resolve(values.repo as string),
      prompt,
      agentId: (mode === "single" ? values.agent : values.lead) as string,
      ...(runWorkers.length > 0 ? { workerIds: runWorkers } : {}),
      ...(values.model ? { model: values.model } : {}),
      ...(values.reasoning ? { reasoningLevel: values.reasoning as string } : {}),
      ...(values.timeout !== undefined ? { timeoutMs: Math.round(Number(values.timeout) * 1000) } : {}),
      ...(values.concurrency !== undefined ? { maxConcurrency: Number(values.concurrency) } : {}),
      ...(values.comparison ? { comparisonId: values.comparison.trim() } : {}),
      ...(values["workspace-strategy"]
        ? { workspaceStrategy: values["workspace-strategy"] as "direct-workspace" | "isolated-worktree" }
        : values.isolated ? { workspaceStrategy: "isolated-worktree" as const } : {}),
    }, json, VERSION)) return;
    console.error(c.red("error: the Bremio daemon is not running."
      + "\n  Start it with:  bremio daemon start"
      + "\n  Or bypass it:   bremio run --standalone ..."));
    process.exitCode = 1;
    return;
  }

  const logger = pino({ level: values.verbose ? "info" : "silent" }, process.stderr);
  const pluginManager = await createCLIPluginManager();
  const registry = pluginManager.getRegistry();

  // Capability gate for lead role — not a name check, so the next
  // capability-only provider won't hit the same bug S1-R4 fixed.
  if (mode === "team" && values.lead) {
    const leadAdapter = registry.get(values.lead);
    if (leadAdapter) {
      const caps = await leadAdapter.getCapabilities();
      const missing: string[] = [];
      if (!caps.planning) missing.push("planning");
      if (!caps.structuredOutput) missing.push("structuredOutput");
      if (missing.length > 0) {
        console.error(c.red(`error: --lead '${values.lead}' lacks required capability: ${missing.join(", ")}`));
        process.exitCode = 2;
        return;
      }
    }
  }

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
          console.log(formatEventView(renderEvent(ev)));
        },
        onPlan: (plan, assign) => printPlan(plan, assign),
        onFallback: (reason, agentId) =>
          console.log(c.yellow(`\n⚠ ${reason}; continuing directly with ${agentId}`)),
        onTaskStart: (task, agentId) =>
          console.log(`\n${c.bold("▶")} ${c.cyan(task.id)} ${task.title} ${c.bold(`→ ${agentId}`)}`),
        // Tasks run concurrently by default, so every streamed line and every
        // completion is tagged — otherwise interleaved output is unreadable.
        onEvent: (task, _agentId, ev) => {
          console.log(`${c.dim(`[${task.id}]`)} ${formatEventView(renderEvent(ev))}`);
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
          console.log(formatEventView(renderEvent(event)));
        },
        onComplete: (result) =>
          console.log(
            `  ${statusGlyph(result.status)} ${c.dim(`(${result.filesChanged.length} file(s), ${Math.round(result.durationMs / 1000)}s)`)}`,
          ),
      };

  try {
    if (mode === "single") {
      const escalationPossible = values.escalate || process.stdout.isTTY;
      const escComparisonId = escalationPossible
        ? (values.comparison?.trim() || `esc-${randomBytes(4).toString("hex")}`)
        : undefined;

      const report = await runSingleAgent({
        primaryAgentId: values.agent as string,
        repoPath,
        prompt,
        registry,
        workspaceStrategy,
        signal: ac.signal,
        hooks: singleHooks,
        ...(values.model ? { model: values.model } : {}),
        ...(values.reasoning
          ? { reasoningLevel: values.reasoning as ReasoningLevel }
          : {}),
        ...(timeoutSeconds !== undefined ? { timeoutMs: Math.round(timeoutSeconds * 1000) } : {}),
        ...(escComparisonId ? { comparisonId: escComparisonId } : {}),
      });

      tagStandalone(report, values.standalone);
      if (json) console.log(JSON.stringify(report, null, 2));
      else printReport(report);

      if (shouldEscalate(report)) {
        if (values.escalate) {
          console.log(c.yellow("\n⚠ Single run failed verification; escalating to Team…"));
          const teamReport = await runBremio({
            leadId: "claude",
            repoPath,
            prompt,
            registry,
            logger,
            signal: ac.signal,
            hooks: teamHooks,
            comparisonId: escComparisonId,
            ...(timeoutSeconds !== undefined ? { taskTimeoutMs: Math.round(timeoutSeconds * 1000) } : {}),
            ...(concurrency !== undefined ? { maxConcurrency: concurrency } : {}),
          });

          tagStandalone(teamReport, values.standalone);
          if (json) console.log(JSON.stringify(teamReport, null, 2));
          else {
            console.log(c.dim("\n── escalated Team run ──"));
            printReport(teamReport);
          }

          process.exitCode = teamReport.mode === "single"
            ? teamReport.result.status === "completed" ? 0 : 1
            : teamReport.summary.failed > 0 ||
                teamReport.tasks.length === 0 ||
                teamReport.qualityGate.status !== "passed"
              ? 1
              : 0;
          return;
        }

        if (process.stdout.isTTY) {
          const rl = createInterface({ input: process.stdin, output: process.stdout });
          const answer = await rl.question(c.yellow("\nSingle run failed verification. Escalate to Team? (y/N) "));
          rl.close();
          // The rule lives in resolveEscalationApproval so it can be proven,
          // not restated here where a typo would silently widen it.
          if (resolveEscalationApproval({ escalateFlag: false, interactive: true, answer }).approved) {
            console.log(c.yellow("Escalating to Team…"));
            const teamReport = await runBremio({
              leadId: "claude",
              repoPath,
              prompt,
              registry,
              logger,
              signal: ac.signal,
              hooks: teamHooks,
              comparisonId: escComparisonId,
              ...(timeoutSeconds !== undefined ? { taskTimeoutMs: Math.round(timeoutSeconds * 1000) } : {}),
              ...(concurrency !== undefined ? { maxConcurrency: concurrency } : {}),
            });

            tagStandalone(teamReport, values.standalone);
            if (json) console.log(JSON.stringify(teamReport, null, 2));
            else {
              console.log(c.dim("\n── escalated Team run ──"));
              printReport(teamReport);
            }

            process.exitCode = teamReport.mode === "single"
              ? teamReport.result.status === "completed" ? 0 : 1
              : teamReport.summary.failed > 0 ||
                  teamReport.tasks.length === 0 ||
                  teamReport.qualityGate.status !== "passed"
                ? 1
                : 0;
            return;
          }
          console.log(c.dim("Escalation declined; Single result and artifacts remain intact."));
        } else {
          console.log(c.dim("\n⚠ Single run failed verification. Use --escalate to retry as a Team."));
        }
      }

      process.exitCode = report.result.status === "completed" ? 0 : 1;
      return;
    }

    const report = await runBremio({
      leadId: values.lead as string,
      ...(runWorkers.length > 0 ? { workerIds: runWorkers } : {}),
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
      ...(isAuto && autoReason ? { autoModeReason: autoReason } : {}),
    });

    tagStandalone(report, values.standalone);
    if (json) console.log(JSON.stringify(report, null, 2));
    else printReport(report);

    process.exitCode = report.mode === "single"
      ? report.result.status === "completed" ? 0 : 1
      : report.summary.failed > 0 ||
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

async function applyCommandFromCli(
  values: Values,
  positionals: string[],
  verb: "apply" | "revert",
): Promise<number> {
  const repoPath = resolveRepo(values);
  if (!repoPath) return 2;
  const runId = positionals[1] ?? values.run;
  if (!runId) {
    console.error(c.red(`error: specify a <runId> to ${verb}`));
    console.log(`\n${USAGE}`);
    return 2;
  }
  return applyCommand({
    repoPath,
    runId,
    revert: verb === "revert",
    force: values.force === true,
    ...(values.task ? { taskId: values.task } : {}),
    ...(values.file ? { filePath: values.file } : {}),
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
    ...(values["open-usage"] ? { openUsage: values["open-usage"] } : {}),
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
  const client = new DaemonClient();
  try {
    const endpoint = await client.connect();
    const meta = await client.handshake();
    console.log(`${c.green("running")} — 127.0.0.1:${endpoint.port} (pid ${endpoint.pid})`);
    console.log(c.dim(`  version ${meta.daemonVersion} · protocol ${meta.protocolVersion}`));
    if (endpoint.startedAt) console.log(c.dim(`  started ${endpoint.startedAt}`));
    return 0;
  } catch (err) {
    if (err instanceof ProtocolMismatchError) {
      console.error(err.message);
      return 1;
    }
    const detail = err instanceof DaemonUnavailableError ? err.message : String(err);
    console.log(`${c.yellow("not running")} — ${detail}`);
    return 0;
  }
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

/** `doctor` for humans, `doctor --json` for a bug report or a script. */
async function doctorCommand(values: Values): Promise<number> {
  if (values.json) {
    const bundle = redactDeep(await collectDiagnostics({ version: VERSION }));
    console.log(JSON.stringify(bundle, null, 2));
    return 0;
  }
  await doctor();
  return 0;
}

async function diagnosticsCommand(values: Values, subcommand?: string): Promise<number> {
  if (subcommand && subcommand !== "export") {
    console.error(c.red(`unknown diagnostics subcommand: ${subcommand}`));
    console.error(c.dim("  expected: bremio diagnostics export [--out <file>]"));
    return 2;
  }
  const target = await exportDiagnostics({
    version: VERSION,
    ...(values.out ? { outputPath: path.resolve(values.out) } : {}),
  });
  console.log(`${c.green("wrote")} ${target}`);
  console.log(
    c.dim("  Credentials are redacted, and prompts and repository contents are never included."),
  );
  return 0;
}

async function doctor(): Promise<void> {
  console.log(c.bold("bremio doctor — adapter health\n"));
  const pm = await createCLIPluginManager();
  for (const [id, adapter] of pm.getRegistry()) {
    const health = await adapter.healthCheck();
    const caps = await adapter.getCapabilities();
    const glyph =
      health.status === "ok"
        ? c.green("ok")
        : health.status === "degraded"
          ? c.yellow("degraded")
          : c.red("unavailable");
    console.log(`  ${id.padEnd(8)} ${glyph}   ${c.dim(health.detail ?? "")}`);
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
