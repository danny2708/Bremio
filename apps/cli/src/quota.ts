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
  agingAfterSeconds?: number;
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
    console.log(c.dim(`  aging after: ${formatAge(options.agingAfterSeconds ?? snapshot.staleAfterSeconds / 2)}`));
    console.log(c.dim(`  stale after: ${formatAge(snapshot.staleAfterSeconds)}`));
    for (const capacity of toAqtCapacitySnapshots(snapshot, {
      ...(options.agingAfterSeconds !== undefined
        ? { agingAfterSeconds: options.agingAfterSeconds }
        : {}),
    })) {
      printCapacity(capacity, snapshot.readAt);
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
): void {
  const status = capacity.status === "healthy"
    ? c.green(capacity.status)
    : capacity.status === "unknown"
      ? c.yellow(capacity.status)
      : c.red(capacity.status);
  const ageSeconds = Math.max(0, readAt - capacity.capturedAt);
  const age = `${formatAge(ageSeconds)} old`;
  const freshness = ` | ${capacity.freshness.toUpperCase()}`;
  const sourceUnavailable = capacity.source.confidenceLabel === "unavailable"
    ? " | SOURCE UNAVAILABLE"
    : "";
  console.log(`\n  ${c.bold(AGENT_LABELS[capacity.agentId] ?? capacity.agentId)}  ${status}`);
  console.log(
    `    source: ${capacity.source.name} | ${capacity.source.confidenceLabel}` +
      ` (${capacity.confidence}) | updated ${new Date(capacity.capturedAt * 1000).toISOString()}` +
      ` | ${age}${freshness}${sourceUnavailable}`,
  );
  if (shouldAlert(capacity)) {
    const alert = `    capacity alert: ${capacity.status}`;
    console.log(capacity.status === "limited" ? c.yellow(alert) : c.red(alert));
  }
  if (capacity.windows.length === 0) console.log(c.dim("    no quota windows available"));
  for (const window of capacity.windows) {
    const remaining = window.remainingPercent === undefined
      ? "unknown"
      : `${window.remainingPercent.toFixed(1)}% remaining`;
    const reset = window.resetsAt
      ? ` | resets ${new Date(window.resetsAt * 1000).toISOString()}`
      : "";
    const windowAge = formatAge(Math.max(0, readAt - window.capturedAt));
    console.log(
      `    - ${window.label}: ${remaining}${reset}` +
        ` | updated ${new Date(window.capturedAt * 1000).toISOString()}` +
        ` (${windowAge} old, ${window.freshness}, ${window.confidence} confidence)`,
    );
  }
}

export function shouldAlert(capacity: AgentCapacitySnapshot): boolean {
  return capacity.status !== "healthy" &&
    capacity.status !== "unknown" &&
    capacity.freshness !== "stale" &&
    capacity.freshness !== "unknown" &&
    capacity.confidence !== "low";
}

function formatAge(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)}h`;
  return `${(seconds / 86400).toFixed(1)}d`;
}
