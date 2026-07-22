import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import type { AgentCapacitySnapshot, QuotaWindow } from "@bremio/quota";
import { quotaCommand, shouldAlert } from "./quota";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

const tempDirs: string[] = [];

function window(overrides: Partial<QuotaWindow> = {}): QuotaWindow {
  return {
    id: "weekly",
    label: "Weekly",
    scope: "account",
    remainingPercent: 18,
    capturedAt: 1_000,
    freshness: "fresh",
    confidence: "high",
    ...overrides,
  };
}

function capacity(
  overrides: Partial<AgentCapacitySnapshot> = {},
): AgentCapacitySnapshot {
  return {
    agentId: "codex",
    availability: "unknown",
    status: "limited",
    confidence: "high",
    source: { name: "Codex app-server", confidenceLabel: "official" },
    lastContactAt: 1_000,
    contactFreshness: "fresh",
    windows: [window()],
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function fixtureDatabase(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bremio-quota-test-"));
  tempDirs.push(dir);
  const databasePath = path.join(dir, "quota.sqlite3");
  const db = new DatabaseSync(databasePath);
  db.exec(`
    PRAGMA user_version = 1;
    CREATE TABLE providers (
      id TEXT PRIMARY KEY, display_name TEXT NOT NULL, enabled INTEGER NOT NULL,
      status TEXT NOT NULL, confidence TEXT NOT NULL, source_name TEXT NOT NULL,
      updated_at INTEGER, error_message TEXT
    );
    CREATE TABLE quota_snapshots (
      id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, bucket_id TEXT NOT NULL,
      bucket_name TEXT NOT NULL, used_percent REAL, remaining_percent REAL,
      unit TEXT, window_minutes INTEGER, reset_at INTEGER, fetched_at INTEGER NOT NULL,
      source_name TEXT NOT NULL, confidence TEXT NOT NULL, severity TEXT NOT NULL
    );
    INSERT INTO providers VALUES
      ('codex', 'OpenAI Codex', 1, 'ok', 'official', 'Codex app-server', 1950, NULL);
    INSERT INTO quota_snapshots VALUES
      ('bucket', 'codex', 'primary', '5-hour', 80, 20, '%', 300, 2100, 1800, 'Codex app-server', 'official', 'warning');
  `);
  db.close();
  return databasePath;
}

describe("Capacity alerts", () => {
  it("alerts on low capacity backed by fresh high-confidence windows", () => {
    expect(shouldAlert(capacity())).toBe(true);
  });

  it("suppresses alerts when a window is stale or low-confidence", () => {
    expect(shouldAlert(capacity({ windows: [window({ freshness: "stale", confidence: "low" })] })))
      .toBe(false);
    expect(shouldAlert(capacity({ windows: [window({ freshness: "aging", confidence: "medium" })] })))
      .toBe(false);
  });

  it("suppresses alerts when a reachable source has only stale numbers", () => {
    // The contact/data split: reaching AQT says nothing about the values, so a
    // fresh contact must not resurrect an alert on six-day-old windows.
    const reachableButStale = capacity({
      contactFreshness: "fresh",
      confidence: "high",
      windows: [window({ freshness: "stale", confidence: "low" })],
    });
    expect(shouldAlert(reachableButStale)).toBe(false);
  });

  it("suppresses alerts with no windows or an unknown status", () => {
    expect(shouldAlert(capacity({ windows: [] }))).toBe(false);
    expect(shouldAlert(capacity({ status: "unknown" }))).toBe(false);
  });
});

describe("quotaCommand", () => {
  it("returns last-known data when called with a not-live service", async () => {
    const databasePath = await fixtureDatabase();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      const code = quotaCommand(
        { databasePath },
        { state: "not-published", error: "process not running" },
      );
      expect(code).toBe(0);
      expect(logSpy).toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
    }
  });
});
