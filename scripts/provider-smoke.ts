import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ClaudeAdapter } from "../packages/adapter-claude/src/index";
import { CodexAdapter } from "../packages/adapter-codex/src/index";
import { createRegistry, runBremio } from "../packages/orchestrator/src/index";

type LeadId = "claude" | "codex";

interface Options {
  leads: LeadId[];
  timeoutMs: number;
  keep: boolean;
}

const PROMPT = `Implement a tiny JavaScript greeting module in this repository.
Use src/greeting.js, export a greeting(name) function, and add a node:test test
under test/. Keep package.json's existing test command. The plan must include
an implementation task, a dependent test task that runs npm test, and a
dependent independent-review task. Keep the change minimal.`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log("Usage: pnpm smoke:providers [--lead claude|codex|both] [--timeout seconds] [--keep]");
    console.log("Runs real providers and consumes quota. Defaults: --lead both --timeout 600.");
    return;
  }
  const options = parseOptions(args);
  for (const leadId of options.leads) await smokeLead(leadId, options);
}

async function smokeLead(leadId: LeadId, options: Options): Promise<void> {
  const repo = await createFixture(leadId);
  let passed = false;
  console.log(`\n=== provider smoke: lead=${leadId} repo=${repo} ===`);
  try {
    const registry = createRegistry([new ClaudeAdapter(), new CodexAdapter()]);
    const report = await runBremio({
      leadId,
      repoPath: repo,
      prompt: PROMPT,
      registry,
      taskTimeoutMs: options.timeoutMs,
      hooks: {
        onLeadStart: (id) => console.log(`lead started: ${id}`),
        onTaskStart: (task, agentId) => console.log(`task started: ${task.id} -> ${agentId}`),
        onTaskComplete: (result) => console.log(`task finished: ${result.taskId} ${result.status}`),
      },
    });

    const delegated = report.tasks.some((task) => task.agentId !== leadId);
    if (!delegated) throw new Error("smoke run did not delegate any task away from the lead");
    if (report.qualityGate.status !== "passed") {
      throw new Error(`quality gate ${report.qualityGate.status}: ${report.qualityGate.reasons.join("; ")}`);
    }
    passed = true;
    console.log(
      `PASS lead=${leadId} run=${report.runId} tasks=${report.summary.completed}/${report.summary.total}`,
    );
  } catch (err) {
    console.error(`FAIL lead=${leadId}: ${(err as Error).message}`);
    console.error(`fixture retained for inspection: ${repo}`);
    throw err;
  } finally {
    if (passed && !options.keep) {
      await fs.rm(repo, { recursive: true, force: true });
    } else if (passed) {
      console.log(`fixture retained by --keep: ${repo}`);
    }
  }
}

async function createFixture(leadId: LeadId): Promise<string> {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), `bremio-provider-${leadId}-`));
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "smoke@bremio.local"]);
  git(repo, ["config", "user.name", "Bremio Provider Smoke"]);
  git(repo, ["config", "core.autocrlf", "false"]);
  await fs.writeFile(
    path.join(repo, "package.json"),
    `${JSON.stringify({ name: "bremio-provider-smoke", private: true, type: "module", scripts: { test: "node --test" } }, null, 2)}\n`,
    "utf8",
  );
  await fs.writeFile(path.join(repo, "README.md"), "# Bremio provider smoke fixture\n", "utf8");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "initial smoke fixture"]);
  return repo;
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

function parseOptions(args: string[]): Options {
  let leads: LeadId[] = ["claude", "codex"];
  let timeoutSeconds = 600;
  let keep = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--keep") {
      keep = true;
    } else if (arg === "--lead") {
      const value = args[index + 1];
      index += 1;
      if (value === "both") leads = ["claude", "codex"];
      else if (value === "claude" || value === "codex") leads = [value];
      else throw new Error("--lead must be claude, codex, or both");
    } else if (arg === "--timeout") {
      const value = Number(args[index + 1]);
      index += 1;
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error("--timeout must be a positive number of seconds");
      }
      timeoutSeconds = value;
    } else {
      throw new Error(`unknown option: ${arg ?? "(missing)"}`);
    }
  }

  return { leads, timeoutMs: timeoutSeconds * 1000, keep };
}

main().catch((err) => {
  console.error(`provider smoke aborted: ${(err as Error).message}`);
  process.exitCode = 1;
});
