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
      // Last successful contact (providers.updated_at), not the oldest bucket.
      lastContactAt: 1_950,
      contactFreshness: "fresh",
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
    expect(snapshot.windows[0]?.modelId).toBe("gemini-3.1-pro");
  });

  it("maps a known bucket key to its verified model id", () => {
    const snapshot = toAgentCapacitySnapshot(SOURCE, "antigravity");
    expect(snapshot.windows[0]).toMatchObject({
      id: "gemini-pro-high",
      modelId: "gemini-3.1-pro",
    });
  });

  it("leaves modelId absent for an unknown bucket key", () => {
    const unknownSource: AqtQuotaSnapshot = {
      ...SOURCE,
      providers: SOURCE.providers.map((provider) =>
        provider.agentId === "antigravity"
          ? {
              ...provider,
              buckets: [
                {
                  bucketId: "bogus-model-unknown",
                  bucketName: "Bogus Model Unknown",
                  remainingPercent: 50,
                  fetchedAt: 1_990,
                  sourceName: "Antigravity language server",
                  confidence: "local_official",
                  severity: "normal",
                },
              ],
            }
          : provider,
      ),
    };
    const snapshot = toAgentCapacitySnapshot(unknownSource, "antigravity");
    expect(snapshot.windows[0]?.modelId).toBeUndefined();
  });

  it("assigns distinct modelIds to multiple Antigravity buckets from different model families", () => {
    const multiSource: AqtQuotaSnapshot = {
      ...SOURCE,
      providers: SOURCE.providers.map((provider) =>
        provider.agentId === "antigravity"
          ? {
              ...provider,
              buckets: [
                {
                  bucketId: "gemini-pro-high",
                  bucketName: "Gemini Pro High",
                  remainingPercent: 30,
                  fetchedAt: 1_980,
                  sourceName: "Antigravity language server",
                  confidence: "local_official",
                  severity: "warning",
                },
                {
                  bucketId: "gemini-35-flash-medium",
                  bucketName: "Gemini 3.5 Flash (Medium)",
                  remainingPercent: 90,
                  fetchedAt: 1_985,
                  sourceName: "Antigravity language server",
                  confidence: "local_official",
                  severity: "normal",
                },
              ],
            }
          : provider,
      ),
    };
    const snapshot = toAgentCapacitySnapshot(multiSource, "antigravity");
    expect(snapshot.windows).toHaveLength(2);
    expect(snapshot.windows[0]).toMatchObject({
      id: "gemini-pro-high",
      modelId: "gemini-3.1-pro",
    });
    expect(snapshot.windows[1]).toMatchObject({
      id: "gemini-35-flash-medium",
      modelId: "gemini-3.5-flash",
    });
  });

  it("returns an explicit unavailable card when AQT has no provider", () => {
    expect(toAgentCapacitySnapshot(SOURCE, "claude")).toEqual({
      agentId: "claude",
      availability: "unknown",
      status: "unknown",
      confidence: "low",
      source: { name: "AI-Quota-Tray", confidenceLabel: "unavailable" },
      lastContactAt: 2_000,
      contactFreshness: "unknown",
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
    // updatedAt 1950 + 150s aging threshold, so 2150 puts contact into aging.
    const snapshot = toAgentCapacitySnapshot({ ...SOURCE, readAt: 2_150 }, "codex");

    expect(snapshot).toMatchObject({ contactFreshness: "aging", confidence: "medium" });
    expect(snapshot.windows[0]).toMatchObject({ freshness: "aging", confidence: "medium" });
  });

  it("keeps a provider fresh on recent contact even when a window's value is older", () => {
    // The whole point of the split: a bucket whose number has not moved is not
    // evidence that contact was lost. Contact (1950) is fresh at 2100 while the
    // untouched 1900 window has already aged.
    const snapshot = toAgentCapacitySnapshot({ ...SOURCE, readAt: 2_100 }, "codex");

    expect(snapshot).toMatchObject({ contactFreshness: "fresh", confidence: "high" });
    expect(snapshot.windows[0]).toMatchObject({ freshness: "aging", confidence: "medium" });
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

    expect(snapshot).toMatchObject({ status: "unknown", contactFreshness: "stale", confidence: "low" });
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

describe("confidence reflects the data, not the connection", () => {
  it("drops to low when AQT could not obtain current numbers", () => {
    // Claude's status-line cache going stale, or the Antigravity language
    // server being down: AQT answers instantly, but the values it hands back
    // are days old. Reporting high confidence there told users to trust a
    // number that was 157 hours out of date.
    const unreachable: AqtQuotaSnapshot = {
      ...SOURCE,
      providers: SOURCE.providers.map((provider) =>
        provider.agentId === "codex" ? { ...provider, status: "unknown" } : provider,
      ),
    };

    const snapshot = toAgentCapacitySnapshot(unreachable, "codex");

    expect(snapshot.contactFreshness).toBe("fresh"); // the source did answer
    expect(snapshot.confidence).toBe("low"); // but its numbers are not current
  });

  it("keeps high confidence when the provider is healthy", () => {
    const snapshot = toAgentCapacitySnapshot(SOURCE, "codex");
    expect(snapshot.status).toBe("limited");
    expect(snapshot.confidence).toBe("high");
  });
});
