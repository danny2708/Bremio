import { existsSync } from "node:fs";
import {
  DEFAULT_STALE_AFTER_SECONDS,
  defaultAqtDatabasePath,
  readAqtQuota,
  type ProviderQuota,
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
    console.log(`${c.bold("Bremio quota")} ${c.dim("(read-only from AI-Quota-Tray)")}`);
    console.log(c.dim(`  database: ${snapshot.databasePath}`));
    console.log(c.dim(`  stale after: ${formatAge(snapshot.staleAfterSeconds)}`));
    for (const provider of snapshot.providers) printProvider(provider);
    return 0;
  } catch (err) {
    console.error(c.red(`error: could not read AI-Quota-Tray quota: ${(err as Error).message}`));
    return 1;
  }
}

function printProvider(provider: ProviderQuota): void {
  const status = provider.status === "healthy"
    ? c.green(provider.status)
    : provider.status === "unknown"
      ? c.yellow(provider.status)
      : c.red(provider.status);
  const age = provider.ageSeconds === undefined ? "no snapshot" : `${formatAge(provider.ageSeconds)} old`;
  console.log(`\n  ${c.bold(provider.displayName)} ${c.dim(`(${provider.providerId})`)}  ${status}`);
  console.log(`    source: ${provider.sourceName} | ${provider.confidence} | ${age}${provider.stale ? " | STALE" : ""}`);
  if (provider.errorMessage) console.log(c.dim(`    provider: ${provider.errorMessage}`));
  for (const bucket of provider.buckets) {
    const remaining = bucket.remainingPercent === undefined
      ? "unknown"
      : `${bucket.remainingPercent.toFixed(1)}% remaining`;
    const reset = bucket.resetsAt ? ` | resets ${new Date(bucket.resetsAt * 1000).toISOString()}` : "";
    console.log(`    - ${bucket.bucketName}: ${remaining}${reset}`);
  }
}

function formatAge(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)}h`;
  return `${(seconds / 86400).toFixed(1)}d`;
}
