import { createHash } from "node:crypto";
import { PlanSchema, type Plan } from "@bremio/protocol";

/**
 * Plan checkpoint (P2-T2, docs/17, docs/19).
 *
 * An opt-in pause between "the lead produced a valid plan" and "any worktree
 * or worker run exists". Whoever drives the run (CLI prompt, daemon approval
 * request) answers approve / reject / edit. An edited plan is untrusted input:
 * it is parsed and semantically re-validated exactly like a lead's plan.
 *
 * Unanswerable checkpoints fail closed (docs/14 ADR-4): the caller's hook
 * returns `reject` with a reason rather than approving on nobody's behalf.
 */
export type PlanCheckpointDecision =
  | { decision: "approve"; decidedBy?: string }
  | { decision: "reject"; reason: string; decidedBy?: string }
  | { decision: "edit"; plan: unknown; decidedBy?: string; reason?: string };

export type OnPlanReady = (
  plan: Plan,
  context: { runId: string; digest: string; assign?: ReadonlyMap<string, string> },
) => Promise<PlanCheckpointDecision>;

export interface PlanCheckpointRecord {
  decision: "approved" | "edited";
  decidedBy?: string;
  /** sha256 of the plan the decider saw. */
  proposedDigest: string;
  /** sha256 of the plan that executes (differs only when edited). */
  executedDigest: string;
}

export class PlanCheckpointError extends Error {
  constructor(
    readonly code: "plan_rejected" | "plan_edit_invalid",
    message: string,
  ) {
    super(message);
    this.name = "PlanCheckpointError";
  }
}

export function planDigest(plan: Plan): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(plan)).digest("hex")}`;
}

/**
 * Ask the hook, and return the plan that may execute. Throws
 * `PlanCheckpointError` on rejection or an invalid edit; nothing has been
 * created on disk by then.
 */
export async function applyPlanCheckpoint(input: {
  plan: Plan;
  runId: string;
  onPlanReady: OnPlanReady;
  /** Same semantic validator the lead's plan passed (throws on failure). */
  validate: (plan: Plan) => void;
}): Promise<{ plan: Plan; record: PlanCheckpointRecord }> {
  const proposedDigest = planDigest(input.plan);
  let answer: PlanCheckpointDecision;
  try {
    answer = await input.onPlanReady(input.plan, { runId: input.runId, digest: proposedDigest });
  } catch (err) {
    // A checkpoint that cannot be answered must not execute anything.
    throw new PlanCheckpointError(
      "plan_rejected",
      `plan checkpoint failed closed: ${(err as Error).message}`,
    );
  }

  if (answer.decision === "approve") {
    return {
      plan: input.plan,
      record: {
        decision: "approved",
        ...(answer.decidedBy ? { decidedBy: answer.decidedBy } : {}),
        proposedDigest,
        executedDigest: proposedDigest,
      },
    };
  }
  if (answer.decision === "reject") {
    throw new PlanCheckpointError("plan_rejected", `plan rejected at checkpoint: ${answer.reason}`);
  }

  const parsed = PlanSchema.safeParse(answer.plan);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new PlanCheckpointError("plan_edit_invalid", `edited plan is invalid: ${detail}`);
  }
  try {
    input.validate(parsed.data);
  } catch (err) {
    throw new PlanCheckpointError("plan_edit_invalid", `edited plan is invalid: ${(err as Error).message}`);
  }
  return {
    plan: parsed.data,
    record: {
      decision: "edited",
      ...(answer.decidedBy ? { decidedBy: answer.decidedBy } : {}),
      proposedDigest,
      executedDigest: planDigest(parsed.data),
    },
  };
}
