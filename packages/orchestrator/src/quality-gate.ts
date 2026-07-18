import { z } from "zod";
import type { Finding, Plan, Task, TaskResult } from "@bremio/protocol";
import { extractJsonObject } from "./lead-manager";
import type { CollectedRun } from "./stream";

const ReviewOutputSchema = z.object({
  summary: z.string().min(1),
  findings: z.array(
    z.object({
      severity: z.enum(["info", "warning", "blocker"]),
      message: z.string().min(1),
      status: z.enum(["open", "fixed"]),
    }),
  ),
});

export const reviewOutputJsonSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "findings"],
  properties: {
    summary: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "message", "status"],
        properties: {
          severity: { type: "string", enum: ["info", "warning", "blocker"] },
          message: { type: "string" },
          status: { type: "string", enum: ["open", "fixed"] },
        },
      },
    },
  },
};

export type ReviewParseResult =
  | { ok: true; summary: string; findings: Finding[] }
  | { ok: false; error: string };

export function parseReviewOutput(run: CollectedRun): ReviewParseResult {
  const candidates: unknown[] = [];
  if (run.outcome.structured !== undefined) candidates.push(run.outcome.structured);
  const text = run.outcome.finalText ?? run.assistantText;
  const extracted = extractJsonObject(text);
  if (extracted !== undefined) candidates.push(extracted);

  let error = "no structured review object found";
  for (const candidate of candidates) {
    const parsed = ReviewOutputSchema.safeParse(candidate);
    if (parsed.success) return { ok: true, ...parsed.data };
    error = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
  }
  return { ok: false, error };
}

export interface QualityGateTask {
  task: Task;
  agentId: string;
  result: TaskResult;
}

export interface QualityGateResult {
  status: "passed" | "failed" | "not-run";
  testTaskIds: string[];
  reviewTaskIds: string[];
  reasons: string[];
}

/** Evaluate whether implementation branches have executable test + independent review evidence. */
export function evaluateQualityGate(plan: Plan, entries: QualityGateTask[]): QualityGateResult {
  const implementations = entries.filter((entry) => entry.task.kind === "implementation");
  const testTaskIds = entries.filter((entry) => entry.task.kind === "test").map((entry) => entry.task.id);
  const reviewTaskIds = entries
    .filter((entry) => entry.task.kind === "review")
    .map((entry) => entry.task.id);
  if (implementations.length === 0) {
    return { status: "not-run", testTaskIds, reviewTaskIds, reasons: [] };
  }

  const byId = new Map(plan.tasks.map((task) => [task.id, task] as const));
  const reasons: string[] = [];
  for (const entry of entries) {
    if (entry.result.status !== "completed") {
      reasons.push(`${entry.task.id} is ${entry.result.status}`);
    }
  }

  for (const implementation of implementations) {
    const tests = entries.filter(
      (entry) => entry.task.kind === "test" && dependsOn(entry.task, implementation.task.id, byId),
    );
    if (tests.length === 0) {
      reasons.push(`${implementation.task.id} has no dependent test task`);
    }
    for (const test of tests) {
      const last = test.result.tests.at(-1);
      if (!last) reasons.push(`${test.task.id} produced no shell test evidence`);
      else if (last.exitCode !== 0) reasons.push(`${test.task.id} final test command exited ${last.exitCode}`);
    }

    const reviews = entries.filter(
      (entry) => entry.task.kind === "review" && dependsOn(entry.task, implementation.task.id, byId),
    );
    if (reviews.length === 0) {
      reasons.push(`${implementation.task.id} has no dependent review task`);
    }
    for (const review of reviews) {
      if (review.agentId === implementation.agentId) {
        reasons.push(`${review.task.id} is self-review by ${review.agentId}`);
      }
      const blockers = review.result.findings.filter(
        (finding) => finding.severity === "blocker" && finding.status === "open",
      );
      if (blockers.length > 0) reasons.push(`${review.task.id} has ${blockers.length} open blocker(s)`);
    }
  }

  return {
    status: reasons.length === 0 ? "passed" : "failed",
    testTaskIds,
    reviewTaskIds,
    reasons: [...new Set(reasons)],
  };
}

function dependsOn(task: Task, targetId: string, byId: Map<string, Task>, seen = new Set<string>()): boolean {
  if (task.dependencies.includes(targetId)) return true;
  for (const dependency of task.dependencies) {
    if (seen.has(dependency)) continue;
    seen.add(dependency);
    const parent = byId.get(dependency);
    if (parent && dependsOn(parent, targetId, byId, seen)) return true;
  }
  return false;
}
