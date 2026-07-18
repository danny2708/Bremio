import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";

/**
 * One append-only usage-ledger line, written after each task completes.
 * Measurement infrastructure ONLY (Phase 4 groundwork) — no routing logic
 * reads this yet, and there are no cost/net_gain fields. It records what
 * already exists in the TaskResult, nothing invented.
 */
export const LedgerEntrySchema = z.object({
  ts: z.string(), // ISO 8601
  runId: z.string(),
  taskId: z.string(),
  provider: z.string(), // the agent that ran it (TaskResult.agentId)
  role: z.string(),
  kind: z.string(),
  status: z.enum(["completed", "failed", "cancelled"]),
  filesChanged: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative().optional(),
  model: z.string().optional(),
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

  for (const e of entries) {
    runs.add(e.runId);
    totalFilesChanged += e.filesChanged;
    if (typeof e.durationMs === "number") {
      durationSum += e.durationMs;
      durationCount += 1;
    }
    if (e.status === "completed") completed += 1;
    else if (e.status === "failed") failed += 1;
    else cancelled += 1;

    const p = (byProvider[e.provider] ??= {
      tasks: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
    });
    p.tasks += 1;
    p[e.status] += 1;
  }

  const totalTasks = entries.length;
  return {
    totalRuns: runs.size,
    totalTasks,
    completed,
    failed,
    cancelled,
    completionRate: totalTasks > 0 ? completed / totalTasks : 0,
    avgDurationMs: durationCount > 0 ? Math.round(durationSum / durationCount) : 0,
    totalFilesChanged,
    byProvider,
  };
}

/** Standard ledger path for a repo. */
export function ledgerPathFor(repoPath: string): string {
  return path.join(repoPath, ".bremio", "ledger.jsonl");
}
