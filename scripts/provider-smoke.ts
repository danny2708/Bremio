import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AntigravityAdapter } from "../packages/adapter-antigravity/src/index";
import { ClaudeAdapter } from "../packages/adapter-claude/src/index";
import { CodexAdapter } from "../packages/adapter-codex/src/index";
import { OpenCodeAdapter } from "../packages/adapter-opencode/src/index";
import { createRegistry, runBremio, runSingleAgent } from "../packages/orchestrator/src/index";

type LeadId = "claude" | "codex";
type AgentId = LeadId | "antigravity" | "opencode";
type SmokeMode = "single" | "team" | "both";

interface Options {
  mode: SmokeMode;
  leads: LeadId[];
  agents: AgentId[];
  workerId?: AgentId;
  timeoutMs: number;
  keep: boolean;
}

const PROMPT = `Implement a tiny JavaScript greeting module in this repository.
Use src/greeting.js, export a greeting(name) function, and add a node:test test
under test/. Keep package.json's existing test command. The plan must include
an implementation task, a dependent test task that runs npm test, and a
dependent independent-review task. Keep the change minimal.`;

const SINGLE_PROMPT = `Implement a tiny JavaScript greeting module in this repository.
Use src/greeting.js, export a greeting(name) function, and add a node:test test
under test/. Keep package.json's existing test command. Work directly in the
current repository, run npm.cmd test, and fix any failure.`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log("Usage: pnpm smoke:providers [--mode single|team|both] [--lead claude|codex|both]");
    console.log("       [--agent claude|codex|antigravity|opencode|both|all] [--worker <agent>]");
    console.log("       [--timeout seconds] [--keep]");
    console.log("Runs real providers and consumes quota. Defaults: --mode team --lead both --timeout 600.");
    return;
  }
  const options = parseOptions(args);
  const failures: string[] = [];
  if (options.mode === "single" || options.mode === "both") {
    for (const agentId of options.agents) {
      try {
        await smokeSingle(agentId, options);
      } catch (err) {
        failures.push(`single/${agentId}: ${(err as Error).message}`);
      }
    }
  }
  if (options.mode === "team" || options.mode === "both") {
    for (const leadId of options.leads) {
      try {
        await smokeLead(leadId, options);
      } catch (err) {
        failures.push(`team/${leadId}: ${(err as Error).message}`);
      }
    }
  }
  if (failures.length > 0) {
    throw new Error(`${failures.length} provider smoke run(s) failed: ${failures.join(" | ")}`);
  }
}

async function smokeSingle(agentId: AgentId, options: Options): Promise<void> {
  const repo = await createFixture(`single-${agentId}`);
  let passed = false;
  console.log(`\n=== provider smoke: mode=single agent=${agentId} repo=${repo} ===`);
  try {
    const registry = createProviderRegistry();
    await assertHealthy(registry.get(agentId), agentId);
    const report = await runSingleAgent({
      primaryAgentId: agentId,
      repoPath: repo,
      prompt: SINGLE_PROMPT,
      registry,
      timeoutMs: options.timeoutMs,
    });
    if (report.result.status !== "completed") {
      throw new Error(report.result.error ?? `agent finished ${report.result.status}`);
    }
    if (report.verification.status !== "passed") {
      throw new Error(`verification ${report.verification.status}: ${report.verification.reasons.join("; ")}`);
    }
    passed = true;
    console.log(`PASS mode=single agent=${agentId} run=${report.runId}`);
  } catch (err) {
    console.error(`FAIL mode=single agent=${agentId}: ${(err as Error).message}`);
    console.error(`fixture retained for inspection: ${repo}`);
    throw err;
  } finally {
    if (passed && !options.keep) await removeFixture(repo);
    else if (passed) console.log(`fixture retained by --keep: ${repo}`);
  }
}

async function smokeLead(leadId: LeadId, options: Options): Promise<void> {
  const repo = await createFixture(leadId);
  let passed = false;
  console.log(`\n=== provider smoke: lead=${leadId} repo=${repo} ===`);
  try {
    const registry = createProviderRegistry();
    await assertHealthy(registry.get(leadId), leadId);
    const workerId = options.workerId ?? (leadId === "claude" ? "codex" : "claude");
    await assertHealthy(registry.get(workerId), workerId);
    const report = await runBremio({
      leadId,
      workerId,
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
    if (report.mode !== "team") {
      throw new Error(
        `provider Team smoke unexpectedly fell back to Single: ${report.fallback?.reason ?? "unknown reason"}`,
      );
    }

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
      await removeFixture(repo);
    } else if (passed) {
      console.log(`fixture retained by --keep: ${repo}`);
    }
  }
}

function createProviderRegistry() {
  return createRegistry([
    new ClaudeAdapter(),
    new CodexAdapter(),
    new AntigravityAdapter(),
    new OpenCodeAdapter(),
  ]);
}

async function assertHealthy(
  adapter: { healthCheck(): Promise<{ status: "ok" | "degraded" | "unavailable"; detail?: string }> } | undefined,
  agentId: AgentId,
): Promise<void> {
  if (!adapter) throw new Error(`adapter ${agentId} is not registered`);
  const health = await adapter.healthCheck();
  if (health.status === "unavailable" || (agentId === "antigravity" && health.status !== "ok") || (agentId === "opencode" && health.status !== "ok")) {
    throw new Error(`${agentId} preflight ${health.status}: ${health.detail ?? "no detail"}`);
  }
  console.log(`preflight ${agentId}: ${health.status}${health.detail ? ` — ${health.detail}` : ""}`);
}

async function createFixture(label: string): Promise<string> {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), `bremio-provider-${label}-`));
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

async function removeFixture(repo: string): Promise<void> {
  const resolved = path.resolve(repo);
  const tempRoot = path.resolve(os.tmpdir());
  if (path.dirname(resolved) !== tempRoot || !path.basename(resolved).startsWith("bremio-provider-")) {
    throw new Error(`refusing to remove unexpected smoke path: ${resolved}`);
  }
  await fs.rm(resolved, { recursive: true, force: true });
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

function parseOptions(args: string[]): Options {
  let mode: SmokeMode = "team";
  let leads: LeadId[] = ["claude", "codex"];
  let agents: AgentId[] = ["claude", "codex", "opencode"];
  let workerId: AgentId | undefined;
  let timeoutSeconds = 600;
  let keep = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--keep") {
      keep = true;
    } else if (arg === "--mode") {
      const value = args[index + 1];
      index += 1;
      if (value === "single" || value === "team" || value === "both") mode = value;
      else throw new Error("--mode must be single, team, or both");
    } else if (arg === "--lead") {
      const value = args[index + 1];
      index += 1;
      if (value === "both") leads = ["claude", "codex"];
      else if (value === "claude" || value === "codex") leads = [value];
      else throw new Error("--lead must be claude, codex, or both");
    } else if (arg === "--agent") {
      const value = args[index + 1];
      index += 1;
      if (value === "both") agents = ["claude", "codex"];
      else if (value === "all") agents = ["claude", "codex", "antigravity", "opencode"];
      else if (value === "claude" || value === "codex" || value === "antigravity" || value === "opencode") agents = [value];
      else throw new Error("--agent must be claude, codex, antigravity, opencode, both, or all");
    } else if (arg === "--worker") {
      const value = args[index + 1];
      index += 1;
      if (value === "claude" || value === "codex" || value === "antigravity" || value === "opencode") workerId = value;
      else throw new Error("--worker must be claude, codex, antigravity, or opencode");
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

  if (workerId && leads.some((leadId) => leadId === workerId)) {
    throw new Error("--worker must differ from every selected --lead");
  }
  return {
    mode,
    leads,
    agents,
    ...(workerId ? { workerId } : {}),
    timeoutMs: timeoutSeconds * 1000,
    keep,
  };
}

main().catch((err) => {
  console.error(`provider smoke aborted: ${(err as Error).message}`);
  process.exitCode = 1;
});
