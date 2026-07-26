import { existsSync } from "node:fs";
import { AntigravityAdapter } from "@bremio/adapter-antigravity";
import { ClaudeAdapter } from "@bremio/adapter-claude";
import { CodexAdapter } from "@bremio/adapter-codex";
import { OpenCodeAdapter } from "@bremio/adapter-opencode";
import type { AgentAdapter, AgentCapabilities, AgentHealth } from "@bremio/adapter-sdk";
import {
  DEFAULT_STALE_AFTER_SECONDS,
  defaultAqtDatabasePath,
  readAqtQuota,
  refreshAqtIfAvailable,
  toAqtCapacitySnapshots,
  type AgentCapacitySnapshot,
  type AqtServiceStatus,
} from "@bremio/quota";

export const AGENT_LABELS: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  antigravity: "Antigravity",
  opencode: "OpenCode",
};

/** Fresh adapter instances. Cheap to construct; health work happens on demand. */
export function createAdapters(): AgentAdapter[] {
  return [new ClaudeAdapter(), new CodexAdapter(), new AntigravityAdapter(), new OpenCodeAdapter()];
}

export interface AgentDiagnostic {
  id: string;
  health: AgentHealth;
  capabilities: AgentCapabilities;
  leadEligible: boolean;
}

/** Probe every adapter concurrently so `doctor` does not serialize slow checks. */
export async function loadDiagnostics(): Promise<AgentDiagnostic[]> {
  return await Promise.all(
    createAdapters().map(async (adapter) => {
      const [health, capabilities] = await Promise.all([
        adapter.healthCheck(),
        adapter.getCapabilities(),
      ]);
      return {
        id: adapter.id,
        health,
        capabilities,
        leadEligible: capabilities.planning && capabilities.structuredOutput,
      };
    }),
  );
}

export interface CapacityView {
  databasePath: string;
  readAt: number;
  snapshots: AgentCapacitySnapshot[];
  /** Whether AI-Quota-Tray answered, so the UI can say if the data is live. */
  service?: AqtServiceStatus;
}

/**
 * Ask AI-Quota-Tray to fetch from the providers, then read what it wrote.
 * AQT owns every provider fetch; a missing tray app degrades to last-known
 * values rather than failing.
 */
export async function loadLiveCapacity(databasePath?: string): Promise<CapacityView> {
  const { status } = await refreshAqtIfAvailable();
  return { ...loadCapacity(databasePath), service: status };
}

/** Read AI-Quota-Tray capacity. Throws with a human-readable reason. */
export function loadCapacity(databasePath?: string): CapacityView {
  const dbPath = databasePath ?? defaultAqtDatabasePath();
  if (!dbPath) {
    throw new Error("cannot locate the AI-Quota-Tray database (pass --db <path>)");
  }
  if (!existsSync(dbPath)) {
    throw new Error(`AI-Quota-Tray database not found: ${dbPath}`);
  }
  const snapshot = readAqtQuota({
    databasePath: dbPath,
    staleAfterSeconds: DEFAULT_STALE_AFTER_SECONDS,
  });
  return {
    databasePath: snapshot.databasePath,
    readAt: snapshot.readAt,
    snapshots: [...toAqtCapacitySnapshots(snapshot)],
  };
}

export function formatAge(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)}h`;
  return `${(seconds / 86400).toFixed(1)}d`;
}

export async function loadSessions(repoPath: string): Promise<any[]> {
  const { daemonStatus, defaultDatabasePath, RunStore } = await import("@bremio/daemon");
  const status = await daemonStatus();
  if (status.running) {
    try {
      const res = await fetch(
        `http://127.0.0.1:${status.endpoint.port}/sessions?repo=${encodeURIComponent(repoPath)}`,
        { headers: { "x-bremio-token": status.endpoint.token } },
      );
      if (res.ok) {
        const data = (await res.json()) as { sessions: any[] };
        if (data.sessions && data.sessions.length > 0) return data.sessions;
      }
    } catch {
      // Fallback to store
    }
  }

  try {
    const store = await RunStore.open(defaultDatabasePath());
    try {
      const sessions = store.listSessions(repoPath);
      if (sessions.length > 0) return sessions;
    } finally {
      store.close();
    }
  } catch {
    // ignore
  }

  // No sessions in store — try importing legacy reports from disk, then re-read.
  if (status.running) {
    try {
      await fetch(`http://127.0.0.1:${status.endpoint.port}/legacy/import`, {
        method: "POST",
        headers: { "x-bremio-token": status.endpoint.token, "Content-Type": "application/json" },
        body: JSON.stringify({ repoPath }),
      });
      const res = await fetch(
        `http://127.0.0.1:${status.endpoint.port}/sessions?repo=${encodeURIComponent(repoPath)}`,
        { headers: { "x-bremio-token": status.endpoint.token } },
      );
      if (res.ok) {
        const data = (await res.json()) as { sessions: any[] };
        return data.sessions ?? [];
      }
    } catch {
      // Fallback to direct store import
    }
  }

  try {
    const store = await RunStore.open(defaultDatabasePath());
    try {
      const { listReports } = await import("@bremio/orchestrator");
      const reports = await listReports(repoPath);
      for (const entry of reports) {
        store.importReport(entry.runId, entry.report as unknown as Record<string, unknown>, repoPath);
      }
      return store.listSessions(repoPath);
    } finally {
      store.close();
    }
  } catch {
    return [];
  }
}

export async function loadSessionDetail(
  sessionId: string,
  repoPath?: string,
): Promise<{ session: any; eventsMap: Map<string, any[]> } | undefined> {
  const { daemonStatus, defaultDatabasePath, RunStore } = await import("@bremio/daemon");
  const status = await daemonStatus();

  if (status.running) {
    try {
      const res = await fetch(
        `http://127.0.0.1:${status.endpoint.port}/sessions/${encodeURIComponent(sessionId)}`,
        { headers: { "x-bremio-token": status.endpoint.token } },
      );
      if (res.ok) {
        const data = (await res.json()) as { session: any };
        const session = data.session;
        const eventsMap = new Map<string, any[]>();
        for (const turn of session.turns ?? []) {
          const runRes = await fetch(
            `http://127.0.0.1:${status.endpoint.port}/runs/${encodeURIComponent(turn.runId)}`,
            { headers: { "x-bremio-token": status.endpoint.token } },
          );
          if (runRes.ok) {
            const runData = (await runRes.json()) as { events?: any[] };
            eventsMap.set(turn.runId, runData.events ?? []);
          }
        }
        return { session, eventsMap };
      }
    } catch {
      // Fallback
    }
  }

  try {
    const store = await RunStore.open(defaultDatabasePath());
    try {
      const session = store.sessionDetail(sessionId);
      if (session) {
        const eventsMap = new Map<string, any[]>();
        for (const turn of session.turns) {
          const persistedEvents = store.readEvents(turn.runId);
          const wireEvents = persistedEvents.map((e) => ({
            seq: e.seq,
            ts: Date.parse(e.timestamp),
            kind: e.type,
            message: (e.payload as any)?.message ?? "",
            data: (e.payload as any)?.data ?? e.payload,
          }));
          eventsMap.set(turn.runId, wireEvents);
        }
        return { session, eventsMap };
      }
    } finally {
      store.close();
    }
  } catch {
    // ignore
  }

  return undefined;
}

