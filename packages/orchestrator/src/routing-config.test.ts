import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getDefaultRoutingConfig, loadRoutingConfig, RoutingConfigSchema } from "./routing-config";

const FIXTURES = fileURLToPath(new URL("../test-fixtures", import.meta.url));
const ORCHESTRATOR_SRC = fileURLToPath(new URL(".", import.meta.url));

describe("routing config schema", () => {
  it("parses a valid file into the expected policy object", async () => {
    const cfg = await loadRoutingConfig(path.resolve(FIXTURES, "valid-routing.yaml"));

    expect(cfg.capacityPolicy).toMatchObject({
      healthyRemainingPercentMin: 60,
      limitedRemainingPercentMin: 25,
      criticalRemainingPercentMin: 10,
      avoidCriticalAgents: true,
      prohibitExhaustedAgents: true,
      reserveLeadCapacityPercent: 20,
      unknownQuotaPenalty: 15,
      criticalQuotaPenalty: 50,
    });

    expect(cfg.scoring).toMatchObject({
      capabilityWeight: 35,
      quotaWeight: 20,
      taskFitWeight: 20,
      qualityWeight: 15,
      speedWeight: 5,
      preferenceWeight: 5,
    });

    expect(cfg.tiers.trivial).toMatchObject({
      claude: "claude-sonnet-4-20250514",
      codex: "gpt-5.6-terra",
    });
    expect(cfg.tiers.critical).toMatchObject({
      claude: "claude-opus-4-20250514",
      codex: "gpt-5.6-zeus",
    });
  });

  it("rejects an invalid tier and includes the config path in the error", async () => {
    const badPath = path.resolve(FIXTURES, "invalid-tier-routing.yaml");
    await expect(loadRoutingConfig(badPath)).rejects.toThrow(badPath);
  });

  it("uses documented defaults when the file is absent", async () => {
    const missingPath = path.resolve(FIXTURES, "nonexistent-routing.yaml");
    const cfg = await loadRoutingConfig(missingPath);
    expect(cfg).toEqual(getDefaultRoutingConfig());
  });

  it("contains no hardcoded provider model id literals in orchestrator source", async () => {
    const files = (await fs.readdir(ORCHESTRATOR_SRC)).filter(
      (f) => f.endsWith(".ts") && f !== "routing-config.test.ts",
    );

    for (const file of files) {
      const content = await fs.readFile(path.join(ORCHESTRATOR_SRC, file), "utf8");
      const lines = content.split("\n");

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line) continue;

        if (
          /["'](claude-sonnet|claude-opus|claude-haiku|gpt-|deepseek|gemini-pro|gemini-flash)["']/.test(line)
        ) {
          throw new Error(
            `provider model id literal found in ${file}:${i + 1}: ${line.trim()}`,
          );
        }
      }
    }
  });
});
