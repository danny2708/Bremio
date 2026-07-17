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
import { c, compactEvent, printPlan, printReport, statusGlyph } from "./ui";

const USAGE = `${c.bold("bremio")} — provider-agnostic orchestrator for AI coding agents

${c.bold("Usage")}
  bremio run --lead <claude|codex> --repo <path> "<prompt>"
  bremio doctor
  bremio --help

${c.bold("run options")}
  --lead <claude|codex>   Which agent leads (plans). Required.
  --repo <path>           Target git repository. Required.
  --model <id>            Model for the lead's planning run (optional).
  --json                  Print the report as JSON (suppresses progress).
  --verbose               Emit structured operational logs to stderr.

The lead plans; the orchestrator hands off tasks to the OTHER agent, each in
its own git worktree under .bremio/worktrees/ (left for manual review).`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      lead: { type: "string" },
      repo: { type: "string" },
      prompt: { type: "string" },
      model: { type: "string" },
      json: { type: "boolean", default: false },
      verbose: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  const command = positionals[0];
  if (values.help || !command) {
    console.log(USAGE);
    return;
  }
  if (command === "doctor") {
    await doctor();
    return;
  }
  if (command !== "run") {
    console.error(c.red(`unknown command: ${command}`));
    console.log(USAGE);
    process.exitCode = 2;
    return;
  }

  const prompt = (values.prompt ?? positionals.slice(1).join(" ")).trim();
  const errors: string[] = [];
  if (values.lead !== "claude" && values.lead !== "codex") {
    errors.push("--lead must be 'claude' or 'codex'");
  }
  if (!values.repo) errors.push("--repo <path> is required");
  if (!prompt) errors.push('a prompt is required, e.g. bremio run ... "add a health endpoint"');
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
  const logger = pino(
    { level: values.verbose ? "info" : "silent" },
    process.stderr,
  );
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
    });

    if (json) console.log(JSON.stringify(report, null, 2));
    else printReport(report);

    process.exitCode = report.summary.failed > 0 || report.tasks.length === 0 ? 1 : 0;
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
    console.log(
      `  ${adapter.id.padEnd(8)} ${glyph}   ${c.dim(health.detail ?? "")}`,
    );
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
