import { existsSync } from "node:fs";
import {
  DEFAULT_STALE_AFTER_SECONDS,
  defaultAqtDatabasePath,
  readAqtQuota,
  refreshAqtIfAvailable,
  toAqtCapacitySnapshots,
  type AgentCapacitySnapshot,
  type AqtServiceStatus,
} from "@bremio/quota";
import { c } from "./ui";

export interface QuotaCommandOptions {
  databasePath?: string;
  staleAfterSeconds?: number;
  agingAfterSeconds?: number;
  /** Ask AI-Quota-Tray to fetch from the providers before reading. */
  refresh?: boolean;
}

/**
 * Trigger a live refresh, then read. AQT owns every provider fetch; Bremio only
 * asks it to run one and then reads the database it writes, so provider parsing
 * is never duplicated across the two projects.
 */
export async function capacityCommand(options: QuotaCommandOptions): Promise<number> {
  let service: AqtServiceStatus | undefined;
  if (options.refresh) {
    const outcome = await refreshAqtIfAvailable();
    service = outcome.status;
    if (outcome.status.state === "live") {
      if (outcome.refresh?.ok) {
        const refreshed = outcome.refresh.results?.filter((r) => r.refreshed).length ?? 0;
        console.log(c.dim(`  refreshed ${refreshed} provider(s) through AI-Quota-Tray`));
      } else {
        console.error(
          c.yellow(`warning: refresh failed, showing last-known data: ${outcome.refresh?.error ?? "unknown error"}`),
        );
      }
    }
  }
  return quotaCommand(options, service);
}

export function quotaCommand(
  options: QuotaCommandOptions,
  service?: AqtServiceStatus,
): number {
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
    printServiceLine(service);
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

/**
 * State the liveness of the source up front. Without this the numbers look
 * authoritative even when the tray app has been closed for days.
 */
function printServiceLine(service: AqtServiceStatus | undefined): void {
  if (!service) return;
  switch (service.state) {
    case "live":
      console.log(
        c.green(`  source: LIVE — AI-Quota-Tray responding${service.version ? ` (v${service.version})` : ""}`),
      );
      return;
    case "stale-endpoint":
      console.log(
        c.yellow("  source: NOT LIVE — AI-Quota-Tray published an endpoint but is not responding; values are last-known"),
      );
      return;
    case "not-published":
      console.log(
        c.yellow("  source: NOT LIVE — AI-Quota-Tray is not running; values are last-known. Start it for live capacity."),
      );
  }
}

function printCapacity(
  capacity: AgentCapacitySnapshot,
  readAt: number,
): void {
  const status = capacity.status === "healthy"
    ? c.green(capacity.status)
    : capacity.status === "unknown"
      ? c.yellow(capacity.status)
      : c.red(capacity.status);
  const ageSeconds = Math.max(0, readAt - capacity.lastContactAt);
  // This age is when AQT last reached the provider, not how old the numbers
  // are — each window carries its own age below. Saying "last contact" keeps
  // the two apart: a source can be reachable while its values are old.
  const age = `last contact ${formatAge(ageSeconds)} ago`;
  const freshness = ` | CONTACT ${capacity.contactFreshness.toUpperCase()}`;
  const sourceUnavailable = capacity.source.confidenceLabel === "unavailable"
    ? " | SOURCE UNAVAILABLE"
    : "";
  console.log(`\n  ${c.bold(AGENT_LABELS[capacity.agentId] ?? capacity.agentId)}  ${status}`);
  console.log(
    `    source: ${capacity.source.name} | ${capacity.source.confidenceLabel}` +
      ` (${capacity.confidence}) | ${age}${freshness}${sourceUnavailable}`,
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

/**
 * Alert only on data we would act on. Trust is a property of the windows, not
 * of contact: a reachable source whose numbers are all stale must not raise a
 * low-capacity alarm. Mirrors `assessCapacity`'s `trusted` rule.
 */
export function shouldAlert(capacity: AgentCapacitySnapshot): boolean {
  const trustedData = capacity.windows.length > 0 &&
    capacity.windows.every(
      (window) => window.freshness === "fresh" && window.confidence === "high",
    );
  return capacity.status !== "healthy" && capacity.status !== "unknown" && trustedData;
}

function formatAge(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)}h`;
  return `${(seconds / 86400).toFixed(1)}d`;
}
