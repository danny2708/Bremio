import { computeStats, ledgerPathFor, readLedger } from "@bremio/orchestrator";
import { c } from "./ui";

export interface StatsCommandOptions {
  repoPath: string;
  since?: Date;
}

/** `bremio stats` — summarize the usage ledger. Measurement only, no routing. */
export async function statsCommand(opts: StatsCommandOptions): Promise<number> {
  const ledgerPath = ledgerPathFor(opts.repoPath);
  const entries = await readLedger(ledgerPath, opts.since ? { since: opts.since } : {});
  const stats = computeStats(entries);

  const scope = opts.since ? `since ${opts.since.toISOString().slice(0, 10)}` : "all time";
  console.log(`${c.bold("Bremio stats")} ${c.dim(`(${scope})`)}`);

  if (stats.totalTasks === 0 && stats.coordinationEntries === 0) {
    console.log(c.dim(`  no ledger entries at ${ledgerPath}`));
    return 0;
  }

  const pct = (stats.completionRate * 100).toFixed(0);
  const avgS = (stats.avgDurationMs / 1000).toFixed(1);
  console.log(`  runs:            ${stats.totalRuns}`);
  console.log(`  tasks:           ${stats.totalTasks}`);
  if (stats.coordinationEntries > 0) {
    const failed = stats.coordinationFailed > 0 ? `${stats.coordinationFailed} failed` : "";
    const cancelled = stats.coordinationCancelled > 0
      ? `${stats.coordinationCancelled} cancelled`
      : "";
    const unsuccessful = [failed, cancelled].filter(Boolean).join(", ");
    console.log(
      `  coordination:    ${stats.coordinationEntries} planning run(s)` +
        (unsuccessful ? c.red(` (${unsuccessful})`) : ""),
    );
  }
  console.log(
    `  completion:      ${pct}%  ${c.dim(`(${stats.completed} completed, ${stats.failed} failed, ${stats.cancelled} cancelled)`)}`,
  );
  console.log(`  avg duration:    ${avgS}s`);
  console.log(`  files changed:   ${stats.totalFilesChanged} total`);
  if (stats.usageEntries > 0) {
    console.log(
      `  reported usage:  ${stats.reportedInputTokens.toLocaleString()} in / ` +
        `${stats.reportedOutputTokens.toLocaleString()} out ` +
        `${c.dim(`(${stats.usageEntries}/${stats.totalTasks + stats.coordinationEntries} ledger entries)`)}`,
    );
    if (stats.reportedCostEntries > 0) {
      console.log(
        `  reported cost:   $${stats.reportedCostUsd.toFixed(4)} ` +
          `${c.dim(`(${stats.reportedCostEntries}/${stats.totalTasks + stats.coordinationEntries} entries; partial)`)}`,
      );
    }
  }

  const providers = Object.keys(stats.byProvider).sort();
  if (providers.length === 0) return 0;
  console.log(`\n  ${c.bold("by provider")}`);
  for (const p of providers) {
    const s = stats.byProvider[p];
    if (!s) continue;
    console.log(
      `    ${p.padEnd(10)} tasks=${String(s.tasks).padEnd(4)} ` +
        `${c.green(`✓${s.completed}`)} ${c.red(`✗${s.failed}`)} ${c.yellow(`◼${s.cancelled}`)}`,
    );
  }
  return 0;
}
