import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Logger } from "pino";
import type { AgentCapabilities } from "@bremio/adapter-sdk";
import type { AgentEvent, Plan, Task } from "@bremio/protocol";
import { WorktreeManager, getCurrentBranch } from "@bremio/workspace";
import { buildReport, type RunReport } from "./aggregator";
import { createPlan } from "./lead-manager";
import { ledgerPathFor } from "./ledger";
import type { AgentRegistry } from "./registry";
import { assignAgents } from "./router";
import { runPlan, type SchedulerHooks } from "./scheduler";
import { validatePlan } from "./validator";

export interface RunBremioHooks extends SchedulerHooks {
  onLeadStart?(leadId: string): void;
  onLeadEvent?(event: AgentEvent): void;
  onPlan?(plan: Plan, assign: Map<string, string>): void;
}

export interface RunBremioOptions {
  leadId: string;
  repoPath: string;
  prompt: string;
  registry: AgentRegistry;
  /** Model for the lead's planning run (workers use their adapter defaults). */
  model?: string;
  /** Hard timeout for each lead attempt and worker task. */
  taskTimeoutMs?: number;
  signal?: AbortSignal;
  logger?: Logger;
  hooks?: RunBremioHooks;
}

/** Generate a sortable, human-readable run id: run-YYYYMMDD-HHMMSS-xxxx. */
export function createRunId(now = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  const stamp =
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `run-${stamp}-${randomBytes(2).toString("hex")}`;
}

/**
 * One Bremio run: lead plans → validate → assign (lead ≠ worker) → sequential
 * worktree execution → aggregate into one report (also written to
 * `.bremio/runs/<runId>/report.json`).
 */
export async function runBremio(opts: RunBremioOptions): Promise<RunReport> {
  const { leadId, prompt, registry, logger } = opts;
  const repoPath = path.resolve(opts.repoPath);
  const runId = createRunId();
  const bremioDir = path.join(repoPath, ".bremio");
  const runDir = path.join(bremioDir, "runs", runId);
  await fs.mkdir(runDir, { recursive: true });
  // Keep Bremio's own state out of the target repo's git status.
  await fs.writeFile(path.join(bremioDir, ".gitignore"), "*\n", "utf8").catch(() => {});

  const lead = registry.get(leadId);
  if (!lead) {
    throw new Error(
      `lead "${leadId}" is not registered (available: ${[...registry.keys()].join(", ") || "none"})`,
    );
  }

  const workspace = new WorktreeManager(repoPath, { runToken: runId.slice(-6) });
  await workspace.assertUsable();
  const baseBranch = await getCurrentBranch(repoPath);

  // Worker = the other registered provider; falls back to the lead (single-agent).
  const workerId = [...registry.keys()].find((id) => id !== leadId) ?? leadId;

  const capabilitiesByAgent = new Map<string, AgentCapabilities>();
  for (const [id, adapter] of registry) {
    capabilitiesByAgent.set(id, await adapter.getCapabilities());
  }

  logger?.info({ runId, leadId, workerId, repoPath }, "starting Bremio run");
  opts.hooks?.onLeadStart?.(leadId);

  const { plan, attempts } = await createPlan(lead, {
    prompt,
    cwd: repoPath,
    runId,
    runDir,
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.taskTimeoutMs ? { timeoutMs: opts.taskTimeoutMs } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.hooks?.onLeadEvent ? { onEvent: opts.hooks.onLeadEvent } : {}),
  });
  logger?.info({ tasks: plan.tasks.length, attempts }, "lead produced a plan");

  validatePlan(plan, capabilitiesByAgent);

  const assign = assignAgents(plan, leadId, workerId);
  opts.hooks?.onPlan?.(plan, assign);
  logger?.info(
    { assignments: Object.fromEntries(assign) },
    "plan validated; tasks assigned",
  );

  const results = await runPlan({
    plan,
    assign,
    registry,
    workspace,
    runDir,
    runId,
    ledgerPath: ledgerPathFor(repoPath),
    ...(opts.taskTimeoutMs ? { taskTimeoutMs: opts.taskTimeoutMs } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.hooks ? { hooks: opts.hooks } : {}),
  });

  const report = buildReport({
    runId,
    prompt,
    leadAgentId: leadId,
    repoPath,
    runDir,
    baseBranch,
    plan,
    assign,
    results,
  });

  await fs.writeFile(
    path.join(runDir, "report.json"),
    JSON.stringify(report, null, 2),
    "utf8",
  );
  logger?.info({ summary: report.summary, runDir }, "run complete");

  return report;
}

export type { Task };
