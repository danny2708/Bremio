import { existsSync } from "node:fs";
import {
  DEFAULT_STALE_AFTER_SECONDS,
  defaultAqtDatabasePath,
  readAqtQuota,
  toAqtCapacitySnapshots,
  type AgentCapacitySnapshot,
} from "@bremio/quota";
import { c } from "./ui";

export interface QuotaCommandOptions {
  databasePath?: string;
  staleAfterSeconds?: number;
}

export function quotaCommand(options: QuotaCommandOptions): number {
  const databasePath = options.databasePath ?? defaultAqtDatabasePath();
  if (!databasePath) {
    console.error(c.red("error: cannot locate AI-Quota-Tray database; pass --db <path>"));
    return 1;
  }
  if (!existsSync(databasePath)) {
    console.error(c.red(`error: AI-Quota-Tray database not found: ${databasePath}`));
    return 1;
  }

  try {
    const snapshot = readAqtQuota({
      databasePath,
      staleAfterSeconds: options.staleAfterSeconds ?? DEFAULT_STALE_AFTER_SECONDS,
    });
    console.log(`${c.bold("Bremio · Capacity")} ${c.dim("(read-only from AI-Quota-Tray)")}`);
    console.log(c.dim(`  database: ${snapshot.databasePath}`));
    console.log(c.dim(`  stale after: ${formatAge(snapshot.staleAfterSeconds)}`));
    for (const capacity of toAqtCapacitySnapshots(snapshot)) {
      printCapacity(capacity, snapshot.readAt, snapshot.staleAfterSeconds);
    }
    return 0;
  } catch (err) {
    console.error(c.red(`error: could not read AI-Quota-Tray quota: ${(err as Error).message}`));
    return 1;
  }
}

const AGENT_LABELS: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  antigravity: "Antigravity",
};

function printCapacity(
  capacity: AgentCapacitySnapshot,
  readAt: number,
  staleAfterSeconds: number,
): void {
  const status = capacity.status === "healthy"
    ? c.green(capacity.status)
    : capacity.status === "unknown"
      ? c.yellow(capacity.status)
      : c.red(capacity.status);
  const ageSeconds = Math.max(0, readAt - capacity.capturedAt);
  const age = `${formatAge(ageSeconds)} old`;
  const stale = ageSeconds > staleAfterSeconds ? " | STALE" : "";
  const sourceUnavailable = capacity.source.confidenceLabel === "unavailable"
    ? " | SOURCE UNAVAILABLE"
    : "";
  console.log(`\n  ${c.bold(AGENT_LABELS[capacity.agentId] ?? capacity.agentId)}  ${status}`);
  console.log(
    `    source: ${capacity.source.name} | ${capacity.source.confidenceLabel}` +
      ` (${capacity.confidence}) | ${age}${stale}${sourceUnavailable}`,
  );
  if (capacity.windows.length === 0) console.log(c.dim("    no quota windows available"));
  for (const window of capacity.windows) {
    const remaining = window.remainingPercent === undefined
      ? "unknown"
      : `${window.remainingPercent.toFixed(1)}% remaining`;
    const reset = window.resetsAt
      ? ` | resets ${new Date(window.resetsAt * 1000).toISOString()}`
      : "";
    console.log(`    - ${window.label}: ${remaining}${reset}`);
  }
}

function formatAge(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)}h`;
  return `${(seconds / 86400).toFixed(1)}d`;
}
