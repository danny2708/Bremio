import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ledgerPathFor,
  readLedger,
  runBremio,
  runSingleAgent,
  type AgentRegistry,
  type BremioRunReport,
} from "@bremio/orchestrator";
import type { ReasoningLevel } from "@bremio/protocol";
import { MergeManager } from "@bremio/workspace";
import {
  BenchRunResultSchema,
  type BenchCaseResult,
  type BenchRunResult,
  type BenchSummary,
  type BenchUsage,
  type LoadedCase,
} from "./schema";
import { UNKNOWN_USAGE, usageForRun } from "./usage";
import { runVerification } from "./verify";
import { installHidden, materializeCase, removeWorkdir } from "./workspace";

export interface BenchRunOptions {
  cases: readonly LoadedCase[];
  mode: "single" | "team";
  registry: AgentRegistry;
  /** Single: the agent. */
  agentId?: string;
  /** Team: the lead, and optionally explicit workers. */
  leadId?: string;
  workerIds?: string[];
  model?: string;
  reasoningLevel?: ReasoningLevel;
  /** Per-case agent timeout; falls back to the case's own `timeoutSec`. */
  timeoutMs?: number;
  /** Where `<benchRunId>.json` is written. */
  outputDir: string;
  /** Parent directory for per-case workdirs (default: OS temp dir). */
  workRoot?: string;
  /** Keep workdirs of every case, not only failed ones. */
  keepAll?: boolean;
  signal?: AbortSignal;
  onCaseStart?(benchCase: LoadedCase, index: number, total: number): void;
  onCaseEnd?(result: BenchCaseResult, index: number, total: number): void;
  now?: () => Date;
}

export function createBenchRunId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
  return `bench-${stamp}-${randomBytes(3).toString("hex")}`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Integrate a passed Team run into its base branch, task by task in plan
 * order, so verification sees what `bremio merge --run` would produce. A
 * conflict stops integration and is recorded; verification then runs on
 * whatever was merged so far.
 */
async function integrateTeamRun(
  report: BremioRunReport,
  workdir: string,
): Promise<{ merged: string[]; error?: string }> {
  const merged: string[] = [];
  if (report.mode !== "team") return { merged };
  const mgr = new MergeManager(workdir);
  const base = report.baseBranch ?? (await mgr.currentBranch());
  try {
    for (const entry of report.tasks) {
      const branch = entry.result.branch;
      if (entry.result.status !== "completed" || !branch) continue;
      if (!(await mgr.branchExists(branch))) continue;
      if ((await mgr.commitsAhead(branch, base)) === 0) continue;
      await mgr.merge(branch, base);
      merged.push(branch);
    }
    return { merged };
  } catch (err) {
    return { merged, error: errorMessage(err) };
  }
}

async function runOneCase(
  benchCase: LoadedCase,
  opts: BenchRunOptions,
): Promise<BenchCaseResult> {
  const def = benchCase.definition;
  const started = Date.now();
  const workdir = await materializeCase(benchCase, opts.workRoot ?? os.tmpdir());
  const timeoutMs = opts.timeoutMs ?? (def.timeoutSec ? def.timeoutSec * 1000 : undefined);

  let runStatus: BenchCaseResult["runStatus"] = "error";
  let runId: string | undefined;
  let qualityGate: BenchCaseResult["qualityGate"] = opts.mode === "single" ? "n/a" : "not-run";
  let integration: BenchCaseResult["integration"];
  let error: string | undefined;

  try {
    if (opts.mode === "single") {
      if (!opts.agentId) throw new Error("single mode needs an agent id");
      const report = await runSingleAgent({
        primaryAgentId: opts.agentId,
        repoPath: workdir,
        prompt: def.prompt,
        registry: opts.registry,
        ...(opts.model ? { model: opts.model } : {}),
        ...(opts.reasoningLevel ? { reasoningLevel: opts.reasoningLevel } : {}),
        ...(timeoutMs ? { timeoutMs } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
      runId = report.runId;
      runStatus = report.result.status;
    } else {
      if (!opts.leadId) throw new Error("team mode needs a lead id");
      const report = await runBremio({
        leadId: opts.leadId,
        repoPath: workdir,
        prompt: def.prompt,
        registry: opts.registry,
        ...(opts.workerIds?.length ? { workerIds: opts.workerIds } : {}),
        ...(opts.model ? { model: opts.model } : {}),
        ...(opts.reasoningLevel ? { reasoningLevel: opts.reasoningLevel } : {}),
        ...(timeoutMs ? { taskTimeoutMs: timeoutMs } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
      runId = report.runId;
      if (report.mode === "team") {
        qualityGate = report.qualityGate.status;
        runStatus = report.summary.cancelled > 0
          ? "cancelled"
          : report.summary.failed > 0 ? "failed" : "completed";
        // Only a passed gate is integrated; otherwise verify the tree as-is,
        // which is what a user who followed Bremio's own merge rule would have.
        if (qualityGate === "passed") integration = await integrateTeamRun(report, workdir);
      } else {
        // Team fell back to Single before any task ran.
        runStatus = report.result.status;
      }
    }
  } catch (err) {
    error = errorMessage(err);
    runStatus = opts.signal?.aborted ? "cancelled" : "error";
  }

  // Verification happens after the agent is finished, on files the agent
  // never saw. It runs even when Bremio reported an error: the bench measures
  // the repository, not Bremio's opinion of it.
  let verification: BenchCaseResult["verification"];
  try {
    await installHidden(benchCase, workdir);
    verification = await runVerification(workdir, def.verify);
  } catch (err) {
    verification = { ok: false, commands: [] };
    error = error ? `${error}; verification: ${errorMessage(err)}` : `verification: ${errorMessage(err)}`;
  }

  let usage: BenchUsage = UNKNOWN_USAGE;
  if (runId) {
    const entries = await readLedger(ledgerPathFor(workdir)).catch(() => []);
    usage = usageForRun(entries, runId);
  }

  const resolved = verification.ok;
  const keep = opts.keepAll || !resolved;
  if (!keep) await removeWorkdir(workdir).catch(() => {});

  return {
    caseId: def.id,
    title: def.title,
    category: def.category,
    language: def.language,
    resolved,
    runStatus,
    ...(runId ? { runId } : {}),
    qualityGate,
    ...(integration ? { integration } : {}),
    verification,
    wallTimeMs: Date.now() - started,
    usage,
    overBudget: def.costBudgetUsd === undefined || usage.costUsd === null
      ? null
      : usage.costUsd > def.costBudgetUsd,
    ...(error ? { error } : {}),
    ...(keep ? { workdir } : {}),
  };
}

/** Aggregate per-case results; unknown cost stays unknown in the total. */
export function summarize(results: readonly BenchCaseResult[]): BenchSummary {
  const resolved = results.filter((r) => r.resolved).length;
  const known = results.filter((r) => r.usage.costUsd !== null);
  const knownCostUsd = Number(known.reduce((sum, r) => sum + (r.usage.costUsd ?? 0), 0).toFixed(6));
  const gated = results.filter((r) => r.qualityGate === "passed" || r.qualityGate === "failed");
  return {
    cases: results.length,
    resolved,
    resolveRate: results.length > 0 ? resolved / results.length : 0,
    totalCostUsd: results.length > 0 && known.length === results.length ? knownCostUsd : null,
    knownCostUsd,
    casesWithKnownCost: known.length,
    totalWallTimeMs: results.reduce((sum, r) => sum + r.wallTimeMs, 0),
    gatePassRate: gated.length > 0
      ? gated.filter((r) => r.qualityGate === "passed").length / gated.length
      : null,
  };
}

export function benchResultPath(outputDir: string, benchRunId: string): string {
  return path.join(outputDir, `${benchRunId}.json`);
}

/**
 * Run every case sequentially (cases share provider quota, and parallel runs
 * would make wall time meaningless), write `<outputDir>/<benchRunId>.json`
 * after each case so an interrupted bench keeps what it measured.
 */
export async function runBench(opts: BenchRunOptions): Promise<BenchRunResult> {
  if (opts.mode === "single" && !opts.agentId) throw new Error("single mode needs --agent");
  if (opts.mode === "team" && !opts.leadId) throw new Error("team mode needs --lead");
  for (const id of [opts.agentId, opts.leadId, ...(opts.workerIds ?? [])]) {
    if (id && !opts.registry.has(id)) throw new Error(`agent "${id}" is not registered`);
  }

  const now = opts.now ?? (() => new Date());
  const createdAt = now();
  const benchRunId = createBenchRunId(createdAt);
  await fs.mkdir(opts.outputDir, { recursive: true });
  const outFile = benchResultPath(opts.outputDir, benchRunId);
  const results: BenchCaseResult[] = [];

  const snapshot = (): BenchRunResult => BenchRunResultSchema.parse({
    schemaVersion: 1,
    benchRunId,
    createdAt: createdAt.toISOString(),
    mode: opts.mode,
    ...(opts.mode === "single" ? { agentId: opts.agentId } : { leadId: opts.leadId }),
    ...(opts.mode === "team" && opts.workerIds?.length ? { workerIds: opts.workerIds } : {}),
    ...(opts.model ? { model: opts.model } : {}),
    cases: results,
    summary: summarize(results),
  });

  const total = opts.cases.length;
  for (const [index, benchCase] of opts.cases.entries()) {
    if (opts.signal?.aborted) break;
    opts.onCaseStart?.(benchCase, index, total);
    const result = await runOneCase(benchCase, opts);
    results.push(result);
    await fs.writeFile(outFile, `${JSON.stringify(snapshot(), null, 2)}\n`, "utf8");
    opts.onCaseEnd?.(result, index, total);
  }

  const final = snapshot();
  await fs.writeFile(outFile, `${JSON.stringify(final, null, 2)}\n`, "utf8");
  return final;
}
