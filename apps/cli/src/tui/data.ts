import { existsSync } from "node:fs";
import { AntigravityAdapter } from "@bremio/adapter-antigravity";
import { ClaudeAdapter } from "@bremio/adapter-claude";
import { CodexAdapter } from "@bremio/adapter-codex";
import type { AgentAdapter, AgentCapabilities, AgentHealth } from "@bremio/adapter-sdk";
import {
  DEFAULT_STALE_AFTER_SECONDS,
  defaultAqtDatabasePath,
  readAqtQuota,
  toAqtCapacitySnapshots,
  type AgentCapacitySnapshot,
} from "@bremio/quota";

export const AGENT_LABELS: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  antigravity: "Antigravity",
};

/** Fresh adapter instances. Cheap to construct; health work happens on demand. */
export function createAdapters(): AgentAdapter[] {
  return [new ClaudeAdapter(), new CodexAdapter(), new AntigravityAdapter()];
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
