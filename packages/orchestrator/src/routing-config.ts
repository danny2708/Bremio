import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import * as yaml from "js-yaml";

export const TierKeySchema = z.enum(["trivial", "low", "medium", "high", "critical"]);
type TierKey = z.infer<typeof TierKeySchema>;

const ModelIdSchema = z.string().min(1);
const AdapterModelMapSchema = z.record(z.string(), ModelIdSchema);

// Accept any string key so an empty object is valid; then validate keys
// against TierKeySchema via superRefine so unknown keys are rejected.
const TierSchema = z.record(z.string(), AdapterModelMapSchema).default({});

export const RoutingConfigSchema = z.object({
  capacityPolicy: z.object({
    healthyRemainingPercentMin: z.number().min(0).max(100).default(50),
    limitedRemainingPercentMin: z.number().min(0).max(100).default(20),
    criticalRemainingPercentMin: z.number().min(0).max(100).default(5),
    avoidCriticalAgents: z.boolean().default(true),
    prohibitExhaustedAgents: z.boolean().default(true),
    reserveLeadCapacityPercent: z.number().min(0).max(100).default(15),
    unknownQuotaPenalty: z.number().min(0).default(10),
    criticalQuotaPenalty: z.number().min(0).default(40),
  }).default({
    healthyRemainingPercentMin: 50,
    limitedRemainingPercentMin: 20,
    criticalRemainingPercentMin: 5,
    avoidCriticalAgents: true,
    prohibitExhaustedAgents: true,
    reserveLeadCapacityPercent: 15,
    unknownQuotaPenalty: 10,
    criticalQuotaPenalty: 40,
  }),
  scoring: z.object({
    capabilityWeight: z.number().min(0).max(100).default(30),
    quotaWeight: z.number().min(0).max(100).default(25),
    taskFitWeight: z.number().min(0).max(100).default(20),
    qualityWeight: z.number().min(0).max(100).default(15),
    speedWeight: z.number().min(0).max(100).default(5),
    preferenceWeight: z.number().min(0).max(100).default(5),
  }).default({
    capabilityWeight: 30,
    quotaWeight: 25,
    taskFitWeight: 20,
    qualityWeight: 15,
    speedWeight: 5,
    preferenceWeight: 5,
  }),
  tiers: TierSchema,
}).superRefine((data, ctx) => {
  for (const key of Object.keys(data.tiers)) {
    const result = TierKeySchema.safeParse(key);
    if (!result.success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["tiers", key],
        message: `Unknown tier key "${key}". Must be one of: trivial, low, medium, high, critical`,
      });
    }
  }
});

export type RoutingConfig = z.infer<typeof RoutingConfigSchema>;

export function getDefaultRoutingConfig(): RoutingConfig {
  return RoutingConfigSchema.parse({});
}

export async function loadRoutingConfig(configPath?: string): Promise<RoutingConfig> {
  const resolvedPath = configPath ?? path.resolve(process.cwd(), "config", "routing.yaml");

  let source: string;
  try {
    source = await fs.readFile(resolvedPath, "utf8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      console.error("config/routing.yaml not found — using documented defaults");
      return getDefaultRoutingConfig();
    }
    throw new Error(
      `failed to read routing config at ${resolvedPath}: ${(err as Error).message}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = yaml.load(source);
  } catch (err: unknown) {
    throw new Error(
      `invalid YAML in routing config at ${resolvedPath}: ${(err as Error).message}`,
    );
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(
      `routing config at ${resolvedPath} must be a YAML mapping (object), got ${typeof parsed}`,
    );
  }

  const result = RoutingConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(
      `invalid routing config at ${resolvedPath}: ${issues}`,
    );
  }

  return result.data;
}
