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
    printWindow(window, readAt);
  }
  printRefreshHint(capacity);
}

/**
 * Print one window, demoting the number when it is not current.
 *
 * A stale percentage stated plainly reads as fact. Bremio was showing Claude at
 * "83.0% remaining" from data six days old while the real figure was far lower,
 * and nothing about the line said not to trust it. A fresh number leads; a
 * stale one is dimmed and labelled as an observation from the past, so the age
 * is impossible to miss rather than buried in a suffix.
 */
function printWindow(window: AgentCapacitySnapshot["windows"][number], readAt: number): void {
  const ageSeconds = Math.max(0, readAt - window.capturedAt);
  const age = formatAge(ageSeconds);
  const reset = window.resetsAt
    ? ` · resets ${new Date(window.resetsAt * 1000).toISOString()}`
    : "";

  if (window.remainingPercent === undefined) {
    console.log(c.dim(`    - ${window.label}: unknown${reset}`));
    return;
  }

  const value = `${window.remainingPercent.toFixed(1)}% remaining`;
  if (window.freshness === "fresh") {
    console.log(`    - ${window.label}: ${value}${c.dim(`${reset} · ${age} old`)}`);
    return;
  }

  // Not current: the reading is history, and saying so is the whole point.
  console.log(
    c.dim(`    - ${window.label}: `) +
      c.yellow(`last observed ${age} ago`) +
      c.dim(` · ${value}${reset}`),
  );
}

/**
 * Tell the user how to make a stale source current instead of leaving them to
 * guess. Claude's numbers only move when Claude Code runs in a terminal, which
 * is not discoverable from the panel.
 */
function printRefreshHint(capacity: AgentCapacitySnapshot): void {
  const allStale = capacity.windows.length > 0 &&
    capacity.windows.every((window) => window.freshness !== "fresh");
  if (!allStale) return;

  const instruction = capacity.agentId === "claude"
    ? "run Claude Code in a terminal once; its status-line bridge is what updates this"
    : capacity.agentId === "antigravity"
      ? "open Antigravity so its language server is running, then refresh"
      : "start AI-Quota-Tray, or run `bremio capacity` to trigger a refresh";
  console.log(c.dim(`      to refresh: ${instruction}`));
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
