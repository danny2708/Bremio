import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultAqtDatabasePath, readAqtQuota } from "./aqt-reader";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function fixture(version = 1): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bremio-aqt-"));
  tempDirs.push(dir);
  const databasePath = path.join(dir, "quota.sqlite3");
  const db = new DatabaseSync(databasePath);
  db.exec(`
    PRAGMA user_version = ${version};
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
      ('codex', 'OpenAI Codex', 1, 'ok', 'official', 'Codex app-server', 1950, NULL),
      ('claude-subscription', 'Claude Code', 1, 'stale', 'local_official', 'Claude bridge', 1500, 'bridge stale');
    INSERT INTO quota_snapshots VALUES
      ('old', 'codex', 'primary', '5-hour', 80, 20, '%', 300, 2100, 1800, 'Codex app-server', 'official', 'warning'),
      ('new', 'codex', 'primary', '5-hour', 10, 90, '%', 300, 2300, 1950, 'Codex app-server', 'official', 'normal'),
      ('claude', 'claude-subscription', 'weekly', 'Weekly', 25, 75, '%', 10080, 3000, 1500, 'Claude bridge', 'local_official', 'normal');
  `);
  db.close();
  return databasePath;
}

describe("readAqtQuota", () => {
  it("reads latest buckets and normalizes provider freshness without writing", async () => {
    const databasePath = await fixture();
    const snapshot = readAqtQuota({ databasePath, staleAfterSeconds: 300, now: 2000 });
    const codex = snapshot.providers.find((provider) => provider.providerId === "codex");
    const claude = snapshot.providers.find(
      (provider) => provider.providerId === "claude-subscription",
    );

    expect(codex).toMatchObject({ agentId: "codex", status: "healthy", stale: false });
    expect(codex?.buckets).toHaveLength(1);
    expect(codex?.buckets[0]?.remainingPercent).toBe(90);
    expect(claude).toMatchObject({ agentId: "claude", status: "unknown", stale: true });
  });

  it("rejects an unknown AQT schema version", async () => {
    const databasePath = await fixture(2);
    expect(() => readAqtQuota({ databasePath })).toThrow(/unsupported AI-Quota-Tray schema/);
  });

  it("ages a provider by its last successful fetch, not by an unchanged bucket", async () => {
    // AQT skips the insert when a bucket's value has not changed, so an old
    // `fetched_at` means "this number has been steady", not "we lost contact".
    // Provider age must therefore come from `providers.updated_at`.
    const databasePath = await fixture();
    const db = new DatabaseSync(databasePath);
    db.exec(`
      INSERT INTO quota_snapshots VALUES
        ('weekly', 'codex', 'weekly', 'Weekly', 5, 95, '%', 10080, 3000, 1000,
         'Codex app-server', 'official', 'normal');
      UPDATE providers SET updated_at = 1950 WHERE id = 'codex';
    `);
    db.close();

    const snapshot = readAqtQuota({ databasePath, staleAfterSeconds: 300, now: 2000 });
    const codex = snapshot.providers.find((provider) => provider.providerId === "codex");
    expect(codex).toMatchObject({ status: "healthy", stale: false, ageSeconds: 50 });
    // The window itself keeps its own, older capture time.
    const weekly = codex?.buckets.find((bucket) => bucket.bucketId === "weekly");
    expect(weekly?.fetchedAt).toBe(1000);
  });

  it("still fails a provider closed once contact itself goes stale", async () => {
    const databasePath = await fixture();
    const db = new DatabaseSync(databasePath);
    db.exec(`UPDATE providers SET updated_at = 1000 WHERE id = 'codex';`);
    db.close();

    const snapshot = readAqtQuota({ databasePath, staleAfterSeconds: 300, now: 2000 });
    const codex = snapshot.providers.find((provider) => provider.providerId === "codex");
    expect(codex).toMatchObject({ status: "unknown", stale: true, ageSeconds: 1000 });
  });
});

describe("defaultAqtDatabasePath", () => {
  it("uses LOCALAPPDATA and does not guess on unsupported environments", () => {
    expect(defaultAqtDatabasePath({ LOCALAPPDATA: "C:\\Local" })).toBe(
      path.join("C:\\Local", "aiquotatray", "AI Quota Tray", "data", "quota-history.sqlite3"),
    );
    expect(defaultAqtDatabasePath({})).toBeUndefined();
  });
});
