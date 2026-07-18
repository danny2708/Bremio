import { describe, expect, it } from "vitest";
import type { AqtQuotaSnapshot } from "./aqt-reader";
import { toAgentCapacitySnapshot, toAqtCapacitySnapshots } from "./aqt-provider";

const SOURCE: AqtQuotaSnapshot = {
  databasePath: "quota.sqlite3",
  schemaVersion: 1,
  readAt: 2_000,
  staleAfterSeconds: 300,
  providers: [
    {
      providerId: "codex",
      agentId: "codex",
      displayName: "OpenAI Codex",
      enabled: true,
      providerStatus: "ok",
      status: "limited",
      stale: false,
      ageSeconds: 100,
      updatedAt: 1_950,
      sourceName: "Codex app-server",
      confidence: "official",
      buckets: [
        {
          bucketId: "primary",
          bucketName: "5-hour",
          usedPercent: 60,
          remainingPercent: 40,
          windowMinutes: 300,
          resetsAt: 2_500,
          fetchedAt: 1_900,
          sourceName: "Codex app-server",
          confidence: "official",
          severity: "warning",
        },
        {
          bucketId: "secondary",
          bucketName: "Weekly",
          remainingPercent: 70,
          fetchedAt: 1_950,
          sourceName: "Codex app-server",
          confidence: "official",
          severity: "normal",
        },
      ],
    },
    {
      providerId: "antigravity",
      agentId: "antigravity",
      displayName: "Antigravity",
      enabled: true,
      providerStatus: "ok",
      status: "healthy",
      stale: false,
      sourceName: "Antigravity language server",
      confidence: "local_official",
      buckets: [
        {
          bucketId: "gemini-pro-high",
          bucketName: "Gemini Pro High",
          remainingPercent: 82,
          fetchedAt: 1_980,
          sourceName: "Antigravity language server",
          confidence: "local_official",
          severity: "normal",
        },
      ],
    },
  ],
};

describe("AQT capacity mapping", () => {
  it("preserves every Codex account window", () => {
    const snapshot = toAgentCapacitySnapshot(SOURCE, "codex");

    expect(snapshot).toMatchObject({
      agentId: "codex",
      availability: "unknown",
      status: "limited",
      confidence: "high",
      capturedAt: 1_900,
      freshness: "fresh",
      source: { name: "Codex app-server", confidenceLabel: "official" },
    });
    expect(snapshot.windows).toHaveLength(2);
    expect(snapshot.windows.map((window) => window.scope)).toEqual(["account", "account"]);
  });

  it("maps Antigravity buckets to model-scoped windows", () => {
    const snapshot = toAgentCapacitySnapshot(SOURCE, "antigravity");

    expect(snapshot.windows[0]).toMatchObject({
      id: "gemini-pro-high",
      scope: "model",
      freshness: "fresh",
      confidence: "high",
    });
    expect(snapshot.windows[0]?.modelId).toBeUndefined();
  });

  it("returns an explicit unavailable card when AQT has no provider", () => {
    expect(toAgentCapacitySnapshot(SOURCE, "claude")).toEqual({
      agentId: "claude",
      availability: "unknown",
      status: "unknown",
      confidence: "low",
      source: { name: "AI-Quota-Tray", confidenceLabel: "unavailable" },
      capturedAt: 2_000,
      freshness: "unknown",
      windows: [],
    });
  });

  it("returns one canonical card for every supported agent", () => {
    expect(toAqtCapacitySnapshots(SOURCE).map((snapshot) => snapshot.agentId)).toEqual([
      "claude",
      "codex",
      "antigravity",
    ]);
  });

  it("degrades high confidence by one level while data is aging", () => {
    const snapshot = toAgentCapacitySnapshot({ ...SOURCE, readAt: 2_100 }, "codex");

    expect(snapshot).toMatchObject({ freshness: "aging", confidence: "medium" });
    expect(snapshot.windows[0]).toMatchObject({ freshness: "aging", confidence: "medium" });
    expect(snapshot.windows[1]).toMatchObject({ freshness: "fresh", confidence: "high" });
  });

  it("retains last-known values but lowers stale confidence", () => {
    const staleSource: AqtQuotaSnapshot = {
      ...SOURCE,
      readAt: 2_301,
      providers: SOURCE.providers.map((provider) =>
        provider.agentId === "codex"
          ? { ...provider, status: "unknown", stale: true }
          : provider,
      ),
    };
    const snapshot = toAgentCapacitySnapshot(staleSource, "codex");

    expect(snapshot).toMatchObject({ status: "unknown", freshness: "stale", confidence: "low" });
    expect(snapshot.windows[0]).toMatchObject({
      remainingPercent: 40,
      freshness: "stale",
      confidence: "low",
    });
  });

  it("rejects an aging threshold outside the stale window", () => {
    expect(() =>
      toAgentCapacitySnapshot(SOURCE, "codex", { agingAfterSeconds: 300 }),
    ).toThrow(/agingAfterSeconds/);
  });
});
