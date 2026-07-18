import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { ReasoningLevelSchema, UsageSummarySchema } from "@bremio/protocol";

/**
 * One append-only ledger line for task, coordination, or run-level evidence.
 * Provider-reported usage is recorded when available; missing usage remains
 * unknown and no cost is estimated. Calibration reads only explicit run
 * summaries and provider-confirmed fields.
 */
export const LedgerEntrySchema = z.object({
  ts: z.string(), // ISO 8601
  runId: z.string(),
  taskId: z.string(),
  /** Missing on legacy entries, which are task entries. */
  scope: z.enum(["task", "coordination", "run"]).optional(),
  provider: z.string(), // the agent that ran it (TaskResult.agentId)
  role: z.string(),
  kind: z.string(),
  status: z.enum(["completed", "failed", "cancelled"]),
  filesChanged: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative().optional(),
  /** Legacy ambiguous identity; retained only so old ledger lines remain readable. */
  model: z.string().optional(),
  requestedModel: z.string().min(1).optional(),
  actualModel: z.string().min(1).optional(),
  requestedReasoningLevel: ReasoningLevelSchema.optional(),
  actualReasoningLevel: ReasoningLevelSchema.optional(),
  usage: UsageSummarySchema.optional(),
  /** Derived from the final assignment map; never inferred from token usage. */
  flowMode: z.enum(["single-agent", "multi-agent"]).optional(),
  /** User-supplied id linking controlled single/multi runs for the same request. */
  comparisonId: z.string().min(1).optional(),
  /** Objective fail-closed report gate outcome, present on scope:"run" entries. */
  qualityGatePassed: z.boolean().optional(),
});
export type LedgerEntry = z.infer<typeof LedgerEntrySchema>;

/** Append one entry to `.bremio/ledger.jsonl` (creating it if needed). */
export async function appendLedgerEntry(
  ledgerPath: string,
  entry: LedgerEntry,
): Promise<void> {
  await fs.mkdir(path.dirname(ledgerPath), { recursive: true });
  await fs.appendFile(ledgerPath, `${JSON.stringify(entry)}\n`, "utf8");
}

export interface ReadLedgerOptions {
  since?: Date;
}

/**
 * Read + parse the ledger. Tolerant: blank lines and malformed/invalid lines
 * are skipped so a single bad append never breaks `bremio stats`.
 */
export async function readLedger(
  ledgerPath: string,
  opts: ReadLedgerOptions = {},
): Promise<LedgerEntry[]> {
  let raw: string;
  try {
    raw = await fs.readFile(ledgerPath, "utf8");
  } catch {
    return []; // no ledger yet
  }

  const entries: LedgerEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const parsed = LedgerEntrySchema.safeParse(obj);
    if (!parsed.success) continue;
    if (opts.since && new Date(parsed.data.ts).getTime() < opts.since.getTime()) continue;
    entries.push(parsed.data);
  }
  return entries;
}

export interface ProviderStats {
  tasks: number;
  completed: number;
  failed: number;
  cancelled: number;
}

export interface LedgerStats {
  totalRuns: number;
  totalTasks: number;
  completed: number;
  failed: number;
  cancelled: number;
  completionRate: number; // 0..1
  avgDurationMs: number;
  totalFilesChanged: number;
  coordinationEntries: number;
  coordinationFailed: number;
  coordinationCancelled: number;
  runEntries: number;
  qualityPassedRuns: number;
  usageEntries: number;
  reportedInputTokens: number;
  reportedOutputTokens: number;
  reportedCostUsd: number;
  reportedCostEntries: number;
  byProvider: Record<string, ProviderStats>;
}

/** Aggregate ledger entries into summary statistics. */
export function computeStats(entries: LedgerEntry[]): LedgerStats {
  const runs = new Set<string>();
  const byProvider: Record<string, ProviderStats> = {};
  let completed = 0;
  let failed = 0;
  let cancelled = 0;
  let totalFilesChanged = 0;
  let durationSum = 0;
  let durationCount = 0;
  let usageEntries = 0;
  let reportedInputTokens = 0;
  let reportedOutputTokens = 0;
  let reportedCostUsd = 0;
  let reportedCostEntries = 0;
  let coordinationEntries = 0;
  let coordinationFailed = 0;
  let coordinationCancelled = 0;
  let runEntries = 0;
  let qualityPassedRuns = 0;
  let totalTasks = 0;

  for (const e of entries) {
    runs.add(e.runId);
    const scope = e.scope ?? "task";
    if (scope === "coordination") {
      coordinationEntries += 1;
      if (e.status === "failed") coordinationFailed += 1;
      else if (e.status === "cancelled") coordinationCancelled += 1;
    } else if (scope === "run") {
      runEntries += 1;
      if (e.qualityGatePassed === true) qualityPassedRuns += 1;
    } else {
      totalTasks += 1;
    }
    if (scope === "task") totalFilesChanged += e.filesChanged;
    if (scope === "task" && typeof e.durationMs === "number") {
      durationSum += e.durationMs;
      durationCount += 1;
    }
    if (e.usage) {
      usageEntries += 1;
      reportedInputTokens += e.usage.inputTokens ?? 0;
      reportedOutputTokens += e.usage.outputTokens ?? 0;
      reportedCostUsd += e.usage.costUsd ?? 0;
      if (e.usage.costUsd !== undefined) reportedCostEntries += 1;
    }
    if (scope === "task") {
      if (e.status === "completed") completed += 1;
      else if (e.status === "failed") failed += 1;
      else cancelled += 1;
    }

    if (scope === "task") {
      const p = (byProvider[e.provider] ??= {
        tasks: 0,
        completed: 0,
        failed: 0,
        cancelled: 0,
      });
      p.tasks += 1;
      p[e.status] += 1;
    }
  }

  return {
    totalRuns: runs.size,
    totalTasks,
    completed,
    failed,
    cancelled,
    completionRate: totalTasks > 0 ? completed / totalTasks : 0,
    avgDurationMs: durationCount > 0 ? Math.round(durationSum / durationCount) : 0,
    totalFilesChanged,
    coordinationEntries,
    coordinationFailed,
    coordinationCancelled,
    runEntries,
    qualityPassedRuns,
    usageEntries,
    reportedInputTokens,
    reportedOutputTokens,
    reportedCostUsd,
    reportedCostEntries,
    byProvider,
  };
}

/** Standard ledger path for a repo. */
export function ledgerPathFor(repoPath: string): string {
  return path.join(repoPath, ".bremio", "ledger.jsonl");
}
