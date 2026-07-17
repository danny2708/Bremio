import { z } from "zod";
import { TaskSchema } from "./task";

/**
 * PlanSchema — the normalized plan a lead returns for one prompt.
 * This is the contract every lead (Claude, Codex, …) must satisfy, so the
 * orchestrator can execute any lead's plan the same way.
 *
 * Structural shape only. Semantic checks (unique ids, dependencies that
 * reference existing tasks, dependency cycles, capability availability) live
 * in the orchestrator validator, keeping this package logic-free.
 */
export const PlanSchema = z.object({
  summary: z.string().min(1),
  /** Which agent authored the plan, e.g. "claude" or "codex". */
  leadAgentId: z.string().min(1),
  tasks: z.array(TaskSchema).min(1, "a plan must contain at least one task"),
});
export type Plan = z.infer<typeof PlanSchema>;
