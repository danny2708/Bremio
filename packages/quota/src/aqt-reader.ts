import { createRequire } from "node:module";
import path from "node:path";
import { z } from "zod";

// Vite 5 does not recognize node:sqlite as a builtin yet; require keeps it external at test time.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

const SUPPORTED_SCHEMA_VERSION = 1;
export const DEFAULT_STALE_AFTER_SECONDS = 30 * 60;

const ProviderRowSchema = z.object({
  id: z.string(),
  display_name: z.string(),
  enabled: z.number().int(),
  status: z.string(),
  confidence: z.string(),
  source_name: z.string(),
  updated_at: z.number().int().nullable(),
  error_message: z.string().nullable(),
});

const BucketRowSchema = z.object({
  provider_id: z.string(),
  bucket_id: z.string(),
  bucket_name: z.string(),
  used_percent: z.number().nullable(),
  remaining_percent: z.number().nullable(),
  window_minutes: z.number().int().nullable(),
  reset_at: z.number().int().nullable(),
  fetched_at: z.number().int(),
  source_name: z.string(),
  confidence: z.string(),
  severity: z.string(),
});

export type QuotaStatus = "healthy" | "limited" | "critical" | "exhausted" | "unknown";

export interface QuotaBucket {
  bucketId: string;
  bucketName: string;
  usedPercent?: number;
  remainingPercent?: number;
  windowMinutes?: number;
  resetsAt?: number;
  fetchedAt: number;
  sourceName: string;
  confidence: string;
  severity: string;
}

export interface ProviderQuota {
  providerId: string;
  /** Bremio adapter id when this AQT provider can participate in routing. */
  agentId?: "claude" | "codex" | "antigravity";
  displayName: string;
  enabled: boolean;
  providerStatus: string;
  status: QuotaStatus;
  stale: boolean;
  ageSeconds?: number;
  updatedAt?: number;
  sourceName: string;
  confidence: string;
  errorMessage?: string;
  buckets: QuotaBucket[];
}

export interface AqtQuotaSnapshot {
  databasePath: string;
  schemaVersion: number;
  readAt: number;
  staleAfterSeconds: number;
  providers: ProviderQuota[];
}

export interface ReadAqtQuotaOptions {
  databasePath: string;
  staleAfterSeconds?: number;
  /** Unix seconds; injectable for deterministic tests. */
  now?: number;
}

const AGENT_BY_PROVIDER: Record<string, ProviderQuota["agentId"]> = {
  codex: "codex",
  "claude-subscription": "claude",
  antigravity: "antigravity",
};

/** Read AI-Quota-Tray's WAL database without mutating it. */
export function readAqtQuota(options: ReadAqtQuotaOptions): AqtQuotaSnapshot {
  const staleAfterSeconds = options.staleAfterSeconds ?? DEFAULT_STALE_AFTER_SECONDS;
  if (!Number.isFinite(staleAfterSeconds) || staleAfterSeconds <= 0) {
    throw new Error("staleAfterSeconds must be a positive number");
  }
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const database = new DatabaseSync(options.databasePath, { readOnly: true });
  try {
    const versionRow = database.prepare("PRAGMA user_version").get() as { user_version?: unknown };
    const schemaVersion = Number(versionRow.user_version);
    if (schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
      throw new Error(
        `unsupported AI-Quota-Tray schema version ${schemaVersion}; expected ${SUPPORTED_SCHEMA_VERSION}`,
      );
    }

    const providerRows = z
      .array(ProviderRowSchema)
      .parse(
        database
          .prepare(
            `SELECT id, display_name, enabled, status, confidence, source_name, updated_at, error_message
             FROM providers ORDER BY id`,
          )
          .all(),
      );
    const bucketRows = z
      .array(BucketRowSchema)
      .parse(
        database
          .prepare(
            `SELECT provider_id, bucket_id, bucket_name, used_percent, remaining_percent,
                    window_minutes, reset_at, fetched_at, source_name, confidence, severity
             FROM (
               SELECT s.*,
                      ROW_NUMBER() OVER (
                        PARTITION BY provider_id, bucket_id
                        ORDER BY fetched_at DESC, id DESC
                      ) AS row_number
               FROM quota_snapshots s
             ) latest
             WHERE row_number = 1
             ORDER BY provider_id, bucket_name`,
          )
          .all(),
      );

    const providers = providerRows.map((provider): ProviderQuota => {
      // A `retired` tombstone means AQT's latest successful fetch no longer
      // reported that bucket, so it describes nothing current: drop it rather
      // than let a withdrawn limit tier keep constraining the provider.
      const buckets = bucketRows
        .filter((bucket) => bucket.provider_id === provider.id && bucket.severity !== "retired")
        .map(toBucket);
      // Provider-level age answers "when did AQT last successfully reach this
      // provider", which is `providers.updated_at` — written on every
      // successful fetch. A bucket's `fetched_at` cannot answer it: AQT skips
      // the insert when a value is unchanged, so a steady quota keeps an old
      // `fetched_at` and would look stale moments after a successful poll.
      //
      // Per-window freshness still comes from each bucket's own `fetched_at`,
      // and routing trusts only that (see assessCapacity) — so this affects
      // reporting, never agent selection.
      const oldestFetchedAt = buckets.reduce<number | undefined>(
        (oldest, bucket) => oldest === undefined || bucket.fetchedAt < oldest ? bucket.fetchedAt : oldest,
        undefined,
      );
      const lastContactAt = provider.updated_at ?? oldestFetchedAt;
      const ageSeconds = lastContactAt === undefined ? undefined : Math.max(0, now - lastContactAt);
      const stale = ageSeconds === undefined || ageSeconds > staleAfterSeconds;
      const agentId = AGENT_BY_PROVIDER[provider.id];
      return {
        providerId: provider.id,
        ...(agentId ? { agentId } : {}),
        displayName: provider.display_name,
        enabled: provider.enabled !== 0,
        providerStatus: provider.status,
        status: normalizeStatus(provider.status, provider.enabled !== 0, stale, buckets),
        stale,
        ...(ageSeconds !== undefined ? { ageSeconds } : {}),
        ...(provider.updated_at !== null ? { updatedAt: provider.updated_at } : {}),
        sourceName: provider.source_name,
        confidence: provider.confidence,
        ...(provider.error_message ? { errorMessage: provider.error_message } : {}),
        buckets,
      };
    });

    return {
      databasePath: options.databasePath,
      schemaVersion,
      readAt: now,
      staleAfterSeconds,
      providers,
    };
  } finally {
    database.close();
  }
}

export function defaultAqtDatabasePath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.LOCALAPPDATA
    ? path.join(env.LOCALAPPDATA, "aiquotatray", "AI Quota Tray", "data", "quota-history.sqlite3")
    : undefined;
}

function toBucket(row: z.infer<typeof BucketRowSchema>): QuotaBucket {
  return {
    bucketId: row.bucket_id,
    bucketName: row.bucket_name,
    ...(row.used_percent !== null ? { usedPercent: row.used_percent } : {}),
    ...(row.remaining_percent !== null ? { remainingPercent: row.remaining_percent } : {}),
    ...(row.window_minutes !== null ? { windowMinutes: row.window_minutes } : {}),
    ...(row.reset_at !== null ? { resetsAt: row.reset_at } : {}),
    fetchedAt: row.fetched_at,
    sourceName: row.source_name,
    confidence: row.confidence,
    severity: row.severity,
  };
}

function normalizeStatus(
  providerStatus: string,
  enabled: boolean,
  stale: boolean,
  buckets: QuotaBucket[],
): QuotaStatus {
  if (!enabled || providerStatus !== "ok" || stale || buckets.length === 0) return "unknown";
  const severities = new Set(buckets.map((bucket) => bucket.severity));
  const remaining = buckets
    .map((bucket) => bucket.remainingPercent)
    .filter((value): value is number => value !== undefined);
  const minimum = remaining.length > 0 ? Math.min(...remaining) : undefined;
  if (severities.has("exhausted") || minimum === 0) return "exhausted";
  if (severities.has("critical") || (minimum !== undefined && minimum <= 10)) return "critical";
  if (severities.has("warning") || (minimum !== undefined && minimum <= 25)) return "limited";
  return minimum === undefined ? "unknown" : "healthy";
}
