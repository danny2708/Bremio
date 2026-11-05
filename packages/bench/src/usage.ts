import type { LedgerEntry } from "@bremio/orchestrator";
import type { BenchUsage } from "./schema";

/**
 * Sum provider-reported usage for one run from its ledger entries (task and
 * coordination scopes — Team planning cost counts against the Team side).
 * Cost is `null` (unknown) when there are no entries or any entry lacks a
 * provider cost: a partial sum would read as cheaper than the run really was.
 * Nothing is estimated.
 */
export function usageForRun(entries: readonly LedgerEntry[], runId: string): BenchUsage {
  const relevant = entries.filter(
    (e) => e.runId === runId && (e.scope === undefined || e.scope === "task" || e.scope === "coordination"),
  );
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let cost = 0;
  let costKnown = relevant.length > 0;
  let withUsage = 0;
  for (const e of relevant) {
    if (e.usage) withUsage += 1;
    if (e.usage?.inputTokens !== undefined) inputTokens = (inputTokens ?? 0) + e.usage.inputTokens;
    if (e.usage?.outputTokens !== undefined) outputTokens = (outputTokens ?? 0) + e.usage.outputTokens;
    if (e.usage?.costUsd === undefined) costKnown = false;
    else cost += e.usage.costUsd;
  }
  return {
    entries: relevant.length,
    entriesWithUsage: withUsage,
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    costUsd: costKnown ? Number(cost.toFixed(6)) : null,
  };
}

/** The usage to report when the run wrote nothing to its ledger. */
export const UNKNOWN_USAGE: BenchUsage = { entries: 0, entriesWithUsage: 0, costUsd: null };
