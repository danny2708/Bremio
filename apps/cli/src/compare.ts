import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { Logger } from "pino";
import {
  appendLedgerEntry,
  computeNetGain,
  ledgerPathFor,
  readLedger,
  runBremio,
  runSingleAgent,
  type AgentRegistry,
  type NetGainResult,
  type RunBremioHooks,
  type RunReport,
  type SingleRunHooks,
  type SingleRunReport,
} from "@bremio/orchestrator";
import type { ReasoningLevel } from "@bremio/protocol";

const execFileAsync = promisify(execFile);

export type ComparisonSide = "single" | "team";

export interface CollectComparisonHooks {
  onSideStart?(side: ComparisonSide): void;
  single?: SingleRunHooks;
  team?: RunBremioHooks;
}

export interface CollectComparisonOptions {
  repoPath: string;
  prompt: string;
  registry: AgentRegistry;
  singleAgentId: string;
  teamLeadId: string;
  teamWorkerId?: string;
  model?: string;
  reasoningLevel?: ReasoningLevel;
  timeoutMs?: number;
  maxConcurrency?: number;
  singleSignal?: AbortSignal;
  teamSignal?: AbortSignal;
  logger?: Logger;
  hooks?: CollectComparisonHooks;
}

export interface ComparisonResult {
  comparisonId: string;
  baseHead: string;
  single: SingleRunReport;
  team: RunReport;
  netGain: NetGainResult;
}

interface WorkspaceSnapshot {
  head: string;
  dirtyFiles: string[];
}

/** Generate an experiment id shared only by this controlled pair. */
export function createComparisonId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `comparison-${stamp}-${randomBytes(3).toString("hex")}`;
}

/**
 * Collect one controlled Single-vs-Team pair.
 *
 * Single runs first in a disposable detached worktree at the captured HEAD.
 * Its ledger stays isolated until Team has started from that same clean HEAD;
 * this prevents the Team kill-switch from turning the comparison into a second
 * Single run. Only measurement records are copied back to the target repo.
 */
export async function collectComparison(
  opts: CollectComparisonOptions,
): Promise<ComparisonResult> {
  const repoPath = path.resolve(opts.repoPath);
  const before = await captureWorkspace(repoPath);
  if (before.dirtyFiles.length > 0) {
    throw new Error(
      `controlled comparison requires a clean working tree; found ` +
        `${before.dirtyFiles.length} dirty file(s): ${before.dirtyFiles.join(", ")}`,
    );
  }
  await assertComparisonProviders(opts);

  const comparisonId = createComparisonId();
  const scratchRoot = path.join(repoPath, ".bremio", "comparisons", comparisonId);
  const singleRepoPath = path.join(scratchRoot, "single-worktree");
  await prepareScratchWorktree(repoPath, singleRepoPath, before.head);

  let single: SingleRunReport;
  let singleEntries = [] as Awaited<ReturnType<typeof readLedger>>;
  try {
    opts.hooks?.onSideStart?.("single");
    single = await runSingleAgent({
      primaryAgentId: opts.singleAgentId,
      repoPath: singleRepoPath,
      prompt: opts.prompt,
      registry: opts.registry,
      comparisonId,
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.reasoningLevel ? { reasoningLevel: opts.reasoningLevel } : {}),
      ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts.singleSignal ? { signal: opts.singleSignal } : {}),
      ...(opts.hooks?.single ? { hooks: opts.hooks.single } : {}),
    });
    singleEntries = await readLedger(ledgerPathFor(singleRepoPath));
  } finally {
    await removeScratchWorktree(repoPath, singleRepoPath, scratchRoot);
  }

  const beforeTeam = await captureWorkspace(repoPath);
  if (beforeTeam.head !== before.head || beforeTeam.dirtyFiles.length > 0) {
    await importLedgerEntries(repoPath, singleEntries);
    throw new Error(
      "working tree changed after the Single baseline; Team was not started because the pair " +
        "would no longer share one tree state",
    );
  }

  let teamReport: Awaited<ReturnType<typeof runBremio>>;
  try {
    opts.hooks?.onSideStart?.("team");
    teamReport = await runBremio({
      leadId: opts.teamLeadId,
      ...(opts.teamWorkerId ? { workerId: opts.teamWorkerId } : {}),
      repoPath,
      prompt: opts.prompt,
      registry: opts.registry,
      comparisonId,
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.reasoningLevel ? { reasoningLevel: opts.reasoningLevel } : {}),
      ...(opts.timeoutMs ? { taskTimeoutMs: opts.timeoutMs } : {}),
      ...(opts.maxConcurrency ? { maxConcurrency: opts.maxConcurrency } : {}),
      ...(opts.teamSignal ? { signal: opts.teamSignal } : {}),
      ...(opts.logger ? { logger: opts.logger } : {}),
      ...(opts.hooks?.team ? { hooks: opts.hooks.team } : {}),
    });
  } finally {
    // A cancelled/failed Single result remains honest evidence even when Team
    // later fails. Its run summary is imported last so Team cannot consume it
    // as a kill-switch baseline during this controlled pair.
    await importLedgerEntries(repoPath, singleEntries);
  }

  if (teamReport.mode !== "team") {
    throw new Error("controlled comparison expected a Team result but received Single fallback");
  }
  const entries = await readLedger(ledgerPathFor(repoPath));
  return {
    comparisonId,
    baseHead: before.head,
    single,
    team: teamReport,
    netGain: computeNetGain(entries, comparisonId, teamReport.runId),
  };
}

async function assertComparisonProviders(opts: CollectComparisonOptions): Promise<void> {
  const single = opts.registry.get(opts.singleAgentId);
  if (!single) throw new Error(`Single agent "${opts.singleAgentId}" is not registered`);
  const lead = opts.registry.get(opts.teamLeadId);
  if (!lead) throw new Error(`Team lead "${opts.teamLeadId}" is not registered`);
  if (opts.teamWorkerId && !opts.registry.has(opts.teamWorkerId)) {
    throw new Error(`Team worker "${opts.teamWorkerId}" is not registered`);
  }
  if (opts.teamWorkerId === opts.teamLeadId) {
    throw new Error("Team worker must be different from the lead");
  }

  const [singleCapabilities, leadCapabilities] = await Promise.all([
    single.getCapabilities(),
    lead.getCapabilities(),
  ]);
  if (!singleCapabilities.repositoryRead || !singleCapabilities.repositoryWrite) {
    throw new Error(`Single agent "${opts.singleAgentId}" cannot run with workspace-write access`);
  }
  const missingLeadCapabilities = [
    !leadCapabilities.planning ? "planning" : undefined,
    !leadCapabilities.structuredOutput ? "structuredOutput" : undefined,
  ].filter((value): value is string => Boolean(value));
  if (missingLeadCapabilities.length > 0) {
    throw new Error(
      `Team lead "${opts.teamLeadId}" lacks required capability: ` +
        missingLeadCapabilities.join(", "),
    );
  }
}

/** Print the controlled pair as two comparable columns plus its net result. */
export function printComparison(result: ComparisonResult): void {
  const singleStatus = result.single.result.status;
  const teamStatus = result.team.summary.cancelled > 0
    ? "cancelled"
    : result.team.summary.failed > 0 || result.team.qualityGate.status !== "passed"
      ? "failed"
      : "completed";
  const rows: Array<[string, string]> = [
    [
      `Single (${result.single.primaryAgentId})`,
      `Team (${result.team.leadAgentId} lead)`,
    ],
    [`run: ${result.single.runId}`, `run: ${result.team.runId}`],
    [`status: ${singleStatus}`, `status: ${teamStatus}`],
    [
      `objective: ${result.single.verification.status}`,
      `objective: ${result.team.qualityGate.status}`,
    ],
  ];
  const width = Math.max(34, ...rows.map(([left]) => left.length + 2));
  console.log(`\nBremio comparison ${result.comparisonId}`);
  console.log(`base: ${result.baseHead}`);
  for (const [left, right] of rows) console.log(`${left.padEnd(width)}| ${right}`);
  console.log(`net gain: ${formatNetGain(result.netGain)}`);
  console.log("Single baseline changes were discarded; Team worktrees remain available for review.");
}

function formatNetGain(result: NetGainResult): string {
  return result.status === "known"
    ? `$${result.netGainUsd.toFixed(4)}`
    : `unknown - ${result.reason}`;
}

async function captureWorkspace(repoPath: string): Promise<WorkspaceSnapshot> {
  try {
    const [{ stdout: head }, { stdout: status }] = await Promise.all([
      execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repoPath, encoding: "utf8" }),
      execFileAsync(
        "git",
        ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
        { cwd: repoPath, encoding: "utf8" },
      ),
    ]);
    return {
      head: head.trim(),
      dirtyFiles: parsePorcelainStatus(status),
    };
  } catch {
    throw new Error(`comparison workspace is not a git repository with a commit: ${repoPath}`);
  }
}

function parsePorcelainStatus(status: string): string[] {
  const records = status.split("\0");
  const files: string[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    files.push(record.slice(3));
    const code = record.slice(0, 2);
    if (code.includes("R") || code.includes("C")) index += 1;
  }
  return files.sort();
}

async function prepareScratchWorktree(
  repoPath: string,
  singleRepoPath: string,
  head: string,
): Promise<void> {
  await fs.mkdir(path.join(repoPath, ".bremio"), { recursive: true });
  await fs.writeFile(path.join(repoPath, ".bremio", ".gitignore"), "*\n", {
    encoding: "utf8",
    flag: "wx",
  }).catch(() => {});
  await fs.mkdir(path.dirname(singleRepoPath), { recursive: true });
  await execFileAsync(
    "git",
    ["worktree", "add", "--detach", singleRepoPath, head],
    { cwd: repoPath, encoding: "utf8" },
  );
}

async function removeScratchWorktree(
  repoPath: string,
  singleRepoPath: string,
  scratchRoot: string,
): Promise<void> {
  await execFileAsync(
    "git",
    ["worktree", "remove", "--force", singleRepoPath],
    { cwd: repoPath, encoding: "utf8" },
  ).catch(() => {});
  await fs.rm(scratchRoot, { recursive: true, force: true });
  await execFileAsync("git", ["worktree", "prune"], { cwd: repoPath, encoding: "utf8" })
    .catch(() => {});
}

async function importLedgerEntries(
  repoPath: string,
  entries: Awaited<ReturnType<typeof readLedger>>,
): Promise<void> {
  const target = ledgerPathFor(repoPath);
  for (const entry of entries) await appendLedgerEntry(target, entry);
}
