import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";

/**
 * Client for AI-Quota-Tray's loopback API.
 *
 * The endpoint is a *trigger*, not a second data source: Bremio asks AQT to
 * refresh, AQT fetches from the providers and persists to its SQLite database,
 * and Bremio then reads that database as it always has. Keeping one data path
 * means provider parsing is never duplicated here, so the two projects cannot
 * drift apart in how a bucket is interpreted.
 */

const EndpointSchema = z.object({
  port: z.number().int().positive().max(65535),
  token: z.string().min(1),
  pid: z.number().int().positive().optional(),
  app: z.string().optional(),
  version: z.string().optional(),
});
export type AqtServiceEndpoint = z.infer<typeof EndpointSchema>;

export type AqtServiceState =
  /** AQT answered on the published port with the published token. */
  | "live"
  /** An endpoint file exists but nothing is listening — AQT exited uncleanly. */
  | "stale-endpoint"
  /** No endpoint file: AQT is not running, or predates the loopback API. */
  | "not-published";

export interface AqtServiceStatus {
  state: AqtServiceState;
  endpoint?: AqtServiceEndpoint;
  /** AQT's own version, when it answered. */
  version?: string;
  error?: string;
}

const DEFAULT_TIMEOUT_MS = 2_000;
/** A provider fetch round can legitimately take a while (Codex spawns a CLI). */
const DEFAULT_REFRESH_TIMEOUT_MS = 45_000;

export function defaultAqtEndpointPath(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return env.LOCALAPPDATA
    ? path.join(
        env.LOCALAPPDATA,
        "aiquotatray",
        "AI Quota Tray",
        "data",
        "bridge",
        "local-api.json",
      )
    : undefined;
}

/** Read the published port/token. Absent or malformed means "not published". */
export async function readAqtServiceEndpoint(
  endpointPath = defaultAqtEndpointPath(),
): Promise<AqtServiceEndpoint | undefined> {
  if (!endpointPath) return undefined;
  try {
    const parsed = EndpointSchema.safeParse(JSON.parse(await fs.readFile(endpointPath, "utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

async function call(
  endpoint: AqtServiceEndpoint,
  route: string,
  init: { method: "GET" | "POST"; timeoutMs: number },
): Promise<Response> {
  return fetch(`http://127.0.0.1:${endpoint.port}${route}`, {
    method: init.method,
    headers: { "X-AQT-Token": endpoint.token },
    signal: AbortSignal.timeout(init.timeoutMs),
  });
}

/**
 * Confirm AQT is actually listening. The endpoint file is only a hint — it
 * survives a crash, so liveness must be proven by connecting.
 */
export async function probeAqtService(
  options: { endpointPath?: string; timeoutMs?: number } = {},
): Promise<AqtServiceStatus> {
  const endpoint = await readAqtServiceEndpoint(
    options.endpointPath ?? defaultAqtEndpointPath(),
  );
  if (!endpoint) return { state: "not-published" };

  try {
    const response = await call(endpoint, "/health", {
      method: "GET",
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    if (!response.ok) {
      return { state: "stale-endpoint", endpoint, error: `health check returned ${response.status}` };
    }
    const body = (await response.json()) as { version?: string };
    return {
      state: "live",
      endpoint,
      ...(body.version ? { version: body.version } : {}),
    };
  } catch (err) {
    return { state: "stale-endpoint", endpoint, error: (err as Error).message };
  }
}

export interface AqtRefreshOutcome {
  ok: boolean;
  /** Per-provider results reported by AQT, when it answered. */
  results?: Array<{ providerId: string; refreshed: boolean; message: string }>;
  error?: string;
}

/**
 * Ask AQT to fetch every tracked provider now and persist the result. Callers
 * should re-read the SQLite database afterwards to observe the new values.
 */
export async function requestAqtRefresh(
  endpoint: AqtServiceEndpoint,
  options: { timeoutMs?: number } = {},
): Promise<AqtRefreshOutcome> {
  try {
    const response = await call(endpoint, "/refresh", {
      method: "POST",
      timeoutMs: options.timeoutMs ?? DEFAULT_REFRESH_TIMEOUT_MS,
    });
    if (!response.ok) {
      return { ok: false, error: `refresh returned ${response.status}` };
    }
    const body = (await response.json()) as { results?: AqtRefreshOutcome["results"] };
    return { ok: true, ...(body.results ? { results: body.results } : {}) };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * Refresh through the service when it is available, otherwise report why not.
 * Never throws: a missing tray app must degrade to last-known data, never fail
 * the caller.
 */
export async function refreshAqtIfAvailable(
  options: { endpointPath?: string; timeoutMs?: number; refreshTimeoutMs?: number } = {},
): Promise<{ status: AqtServiceStatus; refresh?: AqtRefreshOutcome }> {
  const status = await probeAqtService({
    ...(options.endpointPath ? { endpointPath: options.endpointPath } : {}),
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
  });
  if (status.state !== "live" || !status.endpoint) return { status };
  const refresh = await requestAqtRefresh(status.endpoint, {
    ...(options.refreshTimeoutMs ? { timeoutMs: options.refreshTimeoutMs } : {}),
  });
  return { status, refresh };
}

/** Human-readable explanation for why capacity may not be current. */
export function describeAqtService(status: AqtServiceStatus): string {
  switch (status.state) {
    case "live":
      return `AI-Quota-Tray is live${status.version ? ` (v${status.version})` : ""}`;
    case "stale-endpoint":
      return "AI-Quota-Tray published an endpoint but is not responding; it likely exited";
    case "not-published":
      return "AI-Quota-Tray is not running, so capacity is last-known rather than live";
  }
}
