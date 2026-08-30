import {
  computeNetGain,
  computeStats,
  evaluateCalibrationReadiness,
  formatNetGain,
  ledgerPathFor,
  readLedger,
  summarizeNetGain,
  type CalibrationReadiness,
  type LedgerEntry,
  type NetGainAggregate,
  type NetGainResult,
  type NetGainSummary,
} from "@bremio/orchestrator";
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
  const calibration = evaluateCalibrationReadiness(entries);
  const netGain = summarizeNetGain(entries);

  const scope = opts.since ? `since ${opts.since.toISOString().slice(0, 10)}` : "all time";
  console.log(`${c.bold("Bremio stats")} ${c.dim(`(${scope})`)}`);

  if (stats.totalTasks === 0 && stats.coordinationEntries === 0 && stats.runEntries === 0) {
    console.log(c.dim(`  no ledger entries at ${ledgerPath}`));
    printNetGain(netGain);
    printCalibration(calibration);
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
  if (stats.runEntries > 0) {
    console.log(
      `  run outcomes:     ${stats.runEntries} ` +
        `${c.dim(`(${stats.verifiedRuns} objectively verified; ${stats.qualityPassedRuns} Team quality-gate passed)`)}`,
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
  if (providers.length > 0) {
    console.log(`\n  ${c.bold("by provider")}`);
    for (const p of providers) {
      const s = stats.byProvider[p];
      if (!s) continue;
      console.log(
        `    ${p.padEnd(10)} tasks=${String(s.tasks).padEnd(4)} ` +
          `${c.green(`✓${s.completed}`)} ${c.red(`✗${s.failed}`)} ${c.yellow(`◼${s.cancelled}`)}`,
      );
    }
  }
  printNetGain(netGain);
  printCalibration(calibration);
  return 0;
}

function printNetGain(summary: NetGainSummary): void {
  console.log(`\n  ${c.bold("net gain")}`);
  for (const comparison of summary.comparisons) {
    console.log(`    ${comparison.comparisonId}: ${formatNetGain(comparison.aggregate)}`);
  }
  console.log(`    aggregate: ${formatNetGain(summary.aggregate)}`);
}

function printCalibration(readiness: CalibrationReadiness): void {
  const status = readiness.status === "ready"
    ? c.green(readiness.status)
    : c.yellow(readiness.status);
  const expansion = readiness.expansionStatus === "enabled"
    ? c.green(readiness.expansionStatus)
    : c.yellow(readiness.expansionStatus);
  console.log(`\n  ${c.bold("calibration")}: ${status}`);
  console.log(`    recommendation: ${readiness.recommendation}`);
  console.log(`    expansion:      ${expansion}`);
  console.log(
    `    comparisons: ${readiness.pairedComparisons} paired, ` +
      `${readiness.evaluableComparisons} evaluable, ` +
      `${readiness.nonInferiorComparisons} non-inferior`,
  );
  console.log(
    `    coverage: model ${formatPercent(readiness.actualModelCoverage)}, ` +
      `cost ${formatPercent(readiness.reportedCostCoverage)}, ` +
      `coordination ${formatPercent(readiness.coordinationCoverage)}`,
  );
  for (const blocker of readiness.blockers) console.log(c.dim(`    - ${blocker}`));
  if (readiness.status === "ready" && readiness.expansionStatus === "disabled") {
    for (const blocker of readiness.expansionBlockers) {
      if (!readiness.blockers.includes(blocker)) {
        console.log(c.dim(`    - expansion blocked: ${blocker}`));
      }
    }
  }
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

