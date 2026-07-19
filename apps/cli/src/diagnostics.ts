import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AntigravityAdapter } from "@bremio/adapter-antigravity";
import { ClaudeAdapter } from "@bremio/adapter-claude";
import { CodexAdapter } from "@bremio/adapter-codex";
import type { AgentAdapter } from "@bremio/adapter-sdk";
import { PROTOCOL_VERSION, MINIMUM_CLIENT_PROTOCOL } from "@bremio/protocol";
import {
  DEFAULT_STALE_AFTER_SECONDS,
  defaultAqtDatabasePath,
  probeAqtService,
  readAqtQuota,
  toAqtCapacitySnapshots,
} from "@bremio/quota";
import { daemonStatus, defaultDatabasePath, RunStore } from "@bremio/daemon";

/**
 * Machine-readable diagnostics.
 *
 * Written to be pasteable into a bug report, which is exactly why redaction is
 * not optional: this bundle exists to be shared, so anything resembling a
 * credential must never reach it. Prompts and repository contents are excluded
 * for the same reason — a user reporting a daemon problem should not have to
 * publish what they were working on.
 */

export interface Diagnostics {
  generatedAt: string;
  bremio: {
    cliVersion: string;
    protocolVersion: number;
    minimumClientProtocol: number;
  };
  runtime: {
    platform: NodeJS.Platform;
    arch: string;
    release: string;
    node: string;
    /** Whether a POSIX-style shell environment is present, for support triage. */
    shell?: string;
  };
  daemon:
    | { running: true; port: number; pid: number; version: string; protocolVersion: number; startedAt: string }
    | { running: false; staleEndpoint: boolean; detail: string };
  adapters: Array<{
    id: string;
    status: string;
    detail?: string;
    leadEligible: boolean;
    capabilities: Record<string, boolean>;
  }>;
  storage:
    | { present: true; path: string; sizeBytes: number; runs: number; events: number; oldestRun?: string }
    | { present: false; path: string };
  capacity: {
    source: "live" | "last-known" | "unavailable";
    detail: string;
    providers: Array<{
      agentId: string;
      status: string;
      confidence: string;
      contactFreshness: string;
      windows: Array<{ label: string; remainingPercent?: number; ageSeconds: number; freshness: string }>;
    }>;
  };
  notes: string[];
}

/** Keys whose values must never appear in a shareable bundle. */
const SECRET_KEY = /token|secret|password|credential|api[-_]?key|authorization|bearer/i;

/**
 * Strip credentials from any object before it is written out.
 *
 * Applied to the assembled bundle rather than trusted at each producer: a
 * future field that happens to carry a token should be caught by default, not
 * depend on whoever added it remembering.
 */
export function redactDeep(value: unknown, depth = 0): unknown {
  if (depth > 10 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET_KEY.test(key) ? "[redacted]" : redactDeep(item, depth + 1);
  }
  return out;
}

export interface CollectOptions {
  version: string;
  adapters?: AgentAdapter[];
  databasePath?: string;
}

export async function collectDiagnostics(options: CollectOptions): Promise<Diagnostics> {
  const notes: string[] = [];
  const adapters = options.adapters ?? [
    new ClaudeAdapter(),
    new CodexAdapter(),
    new AntigravityAdapter(),
  ];

  const adapterReports = await Promise.all(
    adapters.map(async (adapter) => {
      const [health, capabilities] = await Promise.all([
        adapter.healthCheck(),
        adapter.getCapabilities(),
      ]);
      return {
        id: adapter.id,
        status: health.status,
        ...(health.detail ? { detail: health.detail } : {}),
        leadEligible: capabilities.planning && capabilities.structuredOutput,
        capabilities: { ...capabilities } as unknown as Record<string, boolean>,
      };
    }),
  );

  const status = await daemonStatus();
  const daemon: Diagnostics["daemon"] = status.running
    ? {
        running: true,
        port: status.endpoint.port,
        pid: status.endpoint.pid,
        version: status.endpoint.daemonVersion,
        protocolVersion: status.endpoint.protocolVersion,
        startedAt: status.endpoint.startedAt,
      }
    : { running: false, staleEndpoint: status.staleEndpoint, detail: status.detail };
  if (!status.running && status.staleEndpoint) {
    notes.push("A daemon endpoint is published but nothing answered; it likely crashed.");
  }

  return {
    generatedAt: new Date().toISOString(),
    bremio: {
      cliVersion: options.version,
      protocolVersion: PROTOCOL_VERSION,
      minimumClientProtocol: MINIMUM_CLIENT_PROTOCOL,
    },
    runtime: {
      platform: process.platform,
      arch: process.arch,
      release: os.release(),
      node: process.version,
      ...(process.env.SHELL ? { shell: path.basename(process.env.SHELL) } : {}),
    },
    daemon,
    adapters: adapterReports,
    storage: await inspectStorage(options.databasePath ?? defaultDatabasePath(), notes),
    capacity: await inspectCapacity(notes),
    notes,
  };
}

async function inspectStorage(
  databasePath: string,
  notes: string[],
): Promise<Diagnostics["storage"]> {
  let sizeBytes: number;
  try {
    sizeBytes = (await fs.stat(databasePath)).size;
  } catch {
    return { present: false, path: databasePath };
  }

  // Opening read-only keeps a diagnostics run from disturbing a live daemon.
  try {
    const store = await RunStore.open(databasePath);
    try {
      const runs = store.listRuns({ limit: 1000 });
      const events = runs.reduce((total, run) => total + store.lastSeq(run.id), 0);
      return {
        present: true,
        path: databasePath,
        sizeBytes,
        runs: runs.length,
        events,
        ...(runs.at(-1)?.createdAt ? { oldestRun: runs.at(-1)?.createdAt } : {}),
      };
    } finally {
      store.close();
    }
  } catch (err) {
    notes.push(`Could not read the run database: ${(err as Error).message}`);
    return { present: true, path: databasePath, sizeBytes, runs: 0, events: 0 };
  }
}

async function inspectCapacity(notes: string[]): Promise<Diagnostics["capacity"]> {
  const service = await probeAqtService();
  const databasePath = defaultAqtDatabasePath();
  if (!databasePath) {
    return { source: "unavailable", detail: "no AI-Quota-Tray database path on this platform", providers: [] };
  }

  try {
    const source = readAqtQuota({ databasePath, staleAfterSeconds: DEFAULT_STALE_AFTER_SECONDS });
    const providers = toAqtCapacitySnapshots(source).map((snapshot) => ({
      agentId: snapshot.agentId,
      status: snapshot.status,
      confidence: snapshot.confidence,
      contactFreshness: snapshot.contactFreshness,
      windows: snapshot.windows.map((window) => ({
        label: window.label,
        ...(window.remainingPercent !== undefined
          ? { remainingPercent: window.remainingPercent }
          : {}),
        ageSeconds: Math.max(0, source.readAt - window.capturedAt),
        freshness: window.freshness,
      })),
    }));

    const stale = providers.filter((provider) =>
      provider.windows.every((window) => window.freshness !== "fresh"),
    );
    if (stale.length > 0) {
      notes.push(
        `Capacity numbers for ${stale.map((p) => p.agentId).join(", ")} are last-observed, not current.`,
      );
    }

    return {
      source: service.state === "live" ? "live" : "last-known",
      detail:
        service.state === "live"
          ? "AI-Quota-Tray answered"
          : "AI-Quota-Tray is not running; values are last-known",
      providers,
    };
  } catch (err) {
    return { source: "unavailable", detail: (err as Error).message, providers: [] };
  }
}

/** Write a redacted bundle and return where it landed. */
export async function exportDiagnostics(
  options: CollectOptions & { outputPath?: string },
): Promise<string> {
  const bundle = redactDeep(await collectDiagnostics(options));
  const target =
    options.outputPath ??
    path.join(process.cwd(), `bremio-diagnostics-${Date.now()}.json`);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
  return target;
}
