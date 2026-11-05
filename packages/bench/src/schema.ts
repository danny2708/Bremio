import { z } from "zod";

/**
 * Where a case's hidden verification files land inside the agent's workspace,
 * and the only place they may live. The runner deletes this directory before
 * copying the hidden files in, so an agent cannot plant its own "hidden" test
 * and have it pass verification.
 */
export const HIDDEN_DIR = "__bench__";

export const BenchCategorySchema = z.enum([
  "bug-fix",
  "feature",
  "refactor",
  "test-writing",
  "multi-file",
  "docs",
]);
export type BenchCategory = z.infer<typeof BenchCategorySchema>;

export const BenchLanguageSchema = z.enum(["javascript", "typescript", "python"]);
export type BenchLanguage = z.infer<typeof BenchLanguageSchema>;

/**
 * One verification command, as argv — never a shell string, so a case behaves
 * the same on Windows and POSIX and nothing is interpolated. Two command names
 * are resolved by the runner instead of `PATH`: `node` (the running Node
 * binary) and `python` (`BREMIO_BENCH_PYTHON`, else `python3`, else `python`).
 */
export const VerifyCommandSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  timeoutSec: z.number().int().positive().max(3600).optional(),
});
export type VerifyCommand = z.infer<typeof VerifyCommandSchema>;

/** `bench/cases/<id>/case.json`. */
export const BenchCaseSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/, "id must be kebab-case"),
  title: z.string().min(1),
  category: BenchCategorySchema,
  language: BenchLanguageSchema,
  /** Exactly what the agent receives. Must not mention hidden files. */
  prompt: z.string().min(1),
  /** Every command must exit 0 for the case to count as resolved. */
  verify: z.array(VerifyCommandSchema).min(1),
  /** Default per-case agent timeout when the CLI does not set one. */
  timeoutSec: z.number().int().positive().optional(),
  /** Recorded against provider-reported cost; never enforced mid-run. */
  costBudgetUsd: z.number().positive().optional(),
});
export type BenchCase = z.infer<typeof BenchCaseSchema>;

/** A case on disk: its definition plus the directories it was loaded from. */
export interface LoadedCase {
  definition: BenchCase;
  dir: string;
  repoDir: string;
  hiddenDir: string;
  solutionDir: string;
}

export const BenchUsageSchema = z.object({
  /** Ledger entries (task + coordination) the run wrote. */
  entries: z.number().int().nonnegative(),
  entriesWithUsage: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  /** `null` = unknown: no entries, or at least one entry without provider cost. */
  costUsd: z.number().nonnegative().nullable(),
});
export type BenchUsage = z.infer<typeof BenchUsageSchema>;

export const VerifyCommandResultSchema = z.object({
  command: z.string(),
  args: z.array(z.string()),
  exitCode: z.number().int().nullable(),
  timedOut: z.boolean(),
  durationMs: z.number().int().nonnegative(),
  outputTail: z.string(),
});
export type VerifyCommandResult = z.infer<typeof VerifyCommandResultSchema>;

export const BenchCaseResultSchema = z.object({
  caseId: z.string(),
  title: z.string(),
  category: BenchCategorySchema,
  language: BenchLanguageSchema,
  resolved: z.boolean(),
  /** Bremio's own view of the run; independent of `resolved`. */
  runStatus: z.enum(["completed", "failed", "cancelled", "error"]),
  runId: z.string().optional(),
  /** Team only; `n/a` for Single. */
  qualityGate: z.enum(["passed", "failed", "not-run", "n/a"]),
  /** Team only: task branches merged into base before verification. */
  integration: z
    .object({ merged: z.array(z.string()), error: z.string().optional() })
    .optional(),
  verification: z.object({
    ok: z.boolean(),
    commands: z.array(VerifyCommandResultSchema),
  }),
  wallTimeMs: z.number().int().nonnegative(),
  usage: BenchUsageSchema,
  /** `null` when cost is unknown or the case has no budget. */
  overBudget: z.boolean().nullable(),
  error: z.string().optional(),
  workdir: z.string().optional(),
});
export type BenchCaseResult = z.infer<typeof BenchCaseResultSchema>;

export const BenchSummarySchema = z.object({
  cases: z.number().int().nonnegative(),
  resolved: z.number().int().nonnegative(),
  resolveRate: z.number().min(0).max(1),
  /** `null` = unknown for at least one case. */
  totalCostUsd: z.number().nonnegative().nullable(),
  /** Sum over cases whose cost is known. */
  knownCostUsd: z.number().nonnegative(),
  casesWithKnownCost: z.number().int().nonnegative(),
  totalWallTimeMs: z.number().int().nonnegative(),
  /** Team only: passed / cases whose gate ran. `null` for Single or none ran. */
  gatePassRate: z.number().min(0).max(1).nullable(),
});
export type BenchSummary = z.infer<typeof BenchSummarySchema>;

export const BenchRunResultSchema = z.object({
  schemaVersion: z.literal(1),
  benchRunId: z.string(),
  createdAt: z.string(),
  mode: z.enum(["single", "team"]),
  agentId: z.string().optional(),
  leadId: z.string().optional(),
  workerIds: z.array(z.string()).optional(),
  model: z.string().optional(),
  cases: z.array(BenchCaseResultSchema),
  summary: BenchSummarySchema,
});
export type BenchRunResult = z.infer<typeof BenchRunResultSchema>;
