import { existsSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { pino } from "pino";
import { ClaudeAdapter } from "@bremio/adapter-claude";
import { CodexAdapter } from "@bremio/adapter-codex";
import {
  LeadPlanError,
  PlanValidationError,
  createRegistry,
  runBremio,
  type RunBremioHooks,
} from "@bremio/orchestrator";
import { mergeCommand } from "./merge";
import { quotaCommand } from "./quota";
import { statsCommand } from "./stats";
import { c, compactEvent, printPlan, printReport, statusGlyph } from "./ui";

const USAGE = `${c.bold("bremio")} — provider-agnostic orchestrator for AI coding agents

${c.bold("Usage")}
  bremio run --lead <claude|codex> --repo <path> "<prompt>"
  bremio merge <taskId> [--run <runId>] [--strategy <merge|cherry-pick>] [--yes]
  bremio stats [--since <date>] [--repo <path>]
  bremio quota [--db <path>] [--stale-after <minutes>]
  bremio doctor
  bremio --help

${c.bold("run")}      plan + delegate + execute in isolated worktrees (left for review)
  --lead <claude|codex>   Which agent leads (plans). Required.
  --repo <path>           Target git repository. Required.
  --model <id>            Model for the lead's planning run (optional).
  --timeout <seconds>      Hard timeout for each lead attempt and worker task.
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

${c.bold("quota")}    read normalized quota from AI-Quota-Tray's SQLite database
  --db <path>             Override the default AI-Quota-Tray database path.
  --stale-after <minutes> Treat older snapshots as unknown (default: 30).`;

function parseCli() {
  return parseArgs({
    allowPositionals: true,
    options: {
      lead: { type: "string" },
      repo: { type: "string" },
      prompt: { type: "string" },
      model: { type: "string" },
      timeout: { type: "string" },
      run: { type: "string" },
      base: { type: "string" },
      strategy: { type: "string" },
      since: { type: "string" },
      db: { type: "string" },
      "stale-after": { type: "string" },
      json: { type: "boolean", default: false },
      verbose: { type: "boolean", default: false },
      yes: { type: "boolean", short: "y", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
}

type Values = ReturnType<typeof parseCli>["values"];

async function main(): Promise<void> {
  const { values, positionals } = parseCli();
  const command = positionals[0];

  if (values.help || !command) {
    console.log(USAGE);
    return;
  }

  switch (command) {
    case "run":
      await runCommand(values, positionals);
      return;
    case "merge":
      process.exitCode = await mergeCommandFromCli(values, positionals);
      return;
    case "stats":
      process.exitCode = await statsCommandFromCli(values);
      return;
    case "quota":
      process.exitCode = quotaCommandFromCli(values);
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
  if (values.lead !== "claude" && values.lead !== "codex") {
    errors.push("--lead must be 'claude' or 'codex'");
  }
  if (!values.repo) errors.push("--repo <path> is required");
  if (!prompt) errors.push('a prompt is required, e.g. bremio run ... "add a health endpoint"');
  const timeoutSeconds = values.timeout === undefined ? undefined : Number(values.timeout);
  if (timeoutSeconds !== undefined && (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0)) {
    errors.push("--timeout must be a positive number of seconds");
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

  const leadId = values.lead as "claude" | "codex";
  const json = values.json === true;
  const logger = pino({ level: values.verbose ? "info" : "silent" }, process.stderr);
  const registry = createRegistry([new ClaudeAdapter(), new CodexAdapter()]);

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

  const hooks: RunBremioHooks = json
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
        onEvent: (_task, _agentId, ev) => {
          const l = compactEvent(ev);
          if (l) console.log(l);
        },
        onTaskComplete: (r) =>
          console.log(
            `  ${statusGlyph(r.status)} ${c.dim(`(${r.filesChanged.length} file(s), ${Math.round((r.durationMs ?? 0) / 1000)}s)`)}`,
          ),
      };

  try {
    const report = await runBremio({
      leadId,
      repoPath,
      prompt,
      registry,
      logger,
      signal: ac.signal,
      hooks,
      ...(values.model ? { model: values.model } : {}),
      ...(timeoutSeconds !== undefined ? { taskTimeoutMs: Math.round(timeoutSeconds * 1000) } : {}),
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

function quotaCommandFromCli(values: Values): number {
  const staleMinutes = values["stale-after"] === undefined
    ? undefined
    : Number(values["stale-after"]);
  if (staleMinutes !== undefined && (!Number.isFinite(staleMinutes) || staleMinutes <= 0)) {
    console.error(c.red("error: --stale-after must be a positive number of minutes"));
    return 2;
  }
  return quotaCommand({
    ...(values.db ? { databasePath: path.resolve(values.db) } : {}),
    ...(staleMinutes !== undefined ? { staleAfterSeconds: staleMinutes * 60 } : {}),
  });
}

async function doctor(): Promise<void> {
  console.log(c.bold("bremio doctor — adapter health\n"));
  for (const adapter of [new ClaudeAdapter(), new CodexAdapter()]) {
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
