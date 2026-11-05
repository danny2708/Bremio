import { promises as fs } from "node:fs";
import path from "node:path";
import { BenchRunResultSchema, type BenchCaseResult, type BenchRunResult } from "./schema";

/** Every stored bench result in `outputDir`, oldest first. Invalid files are skipped. */
export async function listBenchResults(outputDir: string): Promise<BenchRunResult[]> {
  let names: string[];
  try {
    names = (await fs.readdir(outputDir)).filter((n) => n.startsWith("bench-") && n.endsWith(".json"));
  } catch {
    return [];
  }
  const results: BenchRunResult[] = [];
  for (const name of names) {
    try {
      const raw = JSON.parse(await fs.readFile(path.join(outputDir, name), "utf8"));
      const parsed = BenchRunResultSchema.safeParse(raw);
      if (parsed.success) results.push(parsed.data);
    } catch {
      // A torn or foreign file must not hide the others.
    }
  }
  return results.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.benchRunId.localeCompare(b.benchRunId));
}

/** Load one result by id, or the newest when `id` is omitted. */
export async function loadBenchResult(outputDir: string, id?: string): Promise<BenchRunResult> {
  const all = await listBenchResults(outputDir);
  if (all.length === 0) throw new Error(`no bench results in ${outputDir}`);
  if (!id) return all[all.length - 1] as BenchRunResult;
  const found = all.find((r) => r.benchRunId === id);
  if (!found) throw new Error(`bench result "${id}" not found in ${outputDir}`);
  return found;
}

export function formatPercent(rate: number | null): string {
  return rate === null ? "n/a" : `${(rate * 100).toFixed(1)}%`;
}

/** Unknown is printed as unknown; a partial known sum is labelled as such. */
export function formatCost(cost: number | null, known?: { knownCostUsd: number; casesWithKnownCost: number; cases: number }): string {
  if (cost !== null) return `$${cost.toFixed(4)}`;
  if (known && known.casesWithKnownCost > 0) {
    return `unknown (known for ${known.casesWithKnownCost}/${known.cases} cases: $${known.knownCostUsd.toFixed(4)})`;
  }
  return "unknown";
}

function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function label(result: BenchRunResult): string {
  return result.mode === "single"
    ? `single/${result.agentId ?? "?"}`
    : `team/${result.leadId ?? "?"}${result.workerIds?.length ? `→${result.workerIds.join(",")}` : ""}`;
}

/** Human-readable summary of one bench run. */
export function formatBenchReport(result: BenchRunResult): string {
  const s = result.summary;
  const lines = [
    `bench ${result.benchRunId}  (${label(result)}${result.model ? `, model ${result.model}` : ""})`,
    `  resolved:   ${s.resolved}/${s.cases}  (${formatPercent(s.cases > 0 ? s.resolveRate : null)})`,
    `  cost:       ${formatCost(s.totalCostUsd, s)}`,
    `  wall time:  ${formatSeconds(s.totalWallTimeMs)}`,
    `  gate pass:  ${formatPercent(s.gatePassRate)}`,
    "",
    "  case                                  result    run        gate      cost        time",
  ];
  for (const c of result.cases) lines.push(`  ${formatCaseRow(c)}`);
  return lines.join("\n");
}

function formatCaseRow(c: BenchCaseResult): string {
  return [
    c.caseId.padEnd(38),
    (c.resolved ? "resolved" : "failed").padEnd(9),
    c.runStatus.padEnd(10),
    c.qualityGate.padEnd(9),
    formatCost(c.usage.costUsd).padEnd(11),
    formatSeconds(c.wallTimeMs),
  ].join(" ");
}

export interface CaseDelta {
  caseId: string;
  before: boolean | null;
  after: boolean | null;
  change: "fixed" | "regressed" | "same" | "added" | "removed";
}

export interface BenchComparison {
  before: BenchRunResult;
  after: BenchRunResult;
  resolveRateDelta: number;
  /** `null` whenever either side's total cost is unknown. */
  costDeltaUsd: number | null;
  wallTimeDeltaMs: number;
  cases: CaseDelta[];
}

export function compareBench(before: BenchRunResult, after: BenchRunResult): BenchComparison {
  const ids = [...new Set([...before.cases.map((c) => c.caseId), ...after.cases.map((c) => c.caseId)])].sort();
  const b = new Map(before.cases.map((c) => [c.caseId, c.resolved] as const));
  const a = new Map(after.cases.map((c) => [c.caseId, c.resolved] as const));
  const cases: CaseDelta[] = ids.map((caseId) => {
    const was = b.has(caseId) ? (b.get(caseId) as boolean) : null;
    const now = a.has(caseId) ? (a.get(caseId) as boolean) : null;
    const change: CaseDelta["change"] = was === null
      ? "added"
      : now === null
        ? "removed"
        : was === now ? "same" : now ? "fixed" : "regressed";
    return { caseId, before: was, after: now, change };
  });
  const bc = before.summary.totalCostUsd;
  const ac = after.summary.totalCostUsd;
  return {
    before,
    after,
    resolveRateDelta: after.summary.resolveRate - before.summary.resolveRate,
    costDeltaUsd: bc === null || ac === null ? null : Number((ac - bc).toFixed(6)),
    wallTimeDeltaMs: after.summary.totalWallTimeMs - before.summary.totalWallTimeMs,
    cases,
  };
}

function signed(n: number, digits: number): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(digits)}`;
}

export function formatComparison(cmp: BenchComparison): string {
  const sameCases = cmp.cases.every((c) => c.change !== "added" && c.change !== "removed");
  const lines = [
    `compare ${cmp.before.benchRunId} (${label(cmp.before)}) → ${cmp.after.benchRunId} (${label(cmp.after)})`,
    `  resolve rate: ${formatPercent(cmp.before.summary.resolveRate)} → ${formatPercent(cmp.after.summary.resolveRate)}  (${signed(cmp.resolveRateDelta * 100, 1)} pts)`,
    `  cost:         ${formatCost(cmp.before.summary.totalCostUsd)} → ${formatCost(cmp.after.summary.totalCostUsd)}  (${cmp.costDeltaUsd === null ? "delta unknown" : `${signed(cmp.costDeltaUsd, 4)} USD`})`,
    `  wall time:    ${formatSeconds(cmp.before.summary.totalWallTimeMs)} → ${formatSeconds(cmp.after.summary.totalWallTimeMs)}`,
    `  gate pass:    ${formatPercent(cmp.before.summary.gatePassRate)} → ${formatPercent(cmp.after.summary.gatePassRate)}`,
  ];
  if (!sameCases) lines.push("  note: the two runs cover different cases; rates are not directly comparable");
  const changed = cmp.cases.filter((c) => c.change !== "same");
  lines.push("", changed.length === 0 ? "  no per-case changes" : "  per-case changes:");
  for (const c of changed) lines.push(`    ${c.change.padEnd(9)} ${c.caseId}`);
  return lines.join("\n");
}
