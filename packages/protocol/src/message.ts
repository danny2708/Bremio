import { z } from "zod";
import { TaskIdSchema } from "./task";

/** Actions a message can perform */
export const TaskMessageActionSchema = z.enum([
  "request-artifact",
  "inform",
  "blocker",
  "done"
]);
export type TaskMessageAction = z.infer<typeof TaskMessageActionSchema>;

/** A task-scoped message used for coordination between tasks or with the orchestrator. */
export const TaskMessageSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  /** Task ID sending the message */
  sourceTaskId: TaskIdSchema,
  /** Target task ID, or "orchestrator" / "lead" */
  targetId: z.string().min(1),
  /** The action/intent of the message */
  act: TaskMessageActionSchema,
  /** Main content or payload (e.g. artifact name, blocker reason) */
  payload: z.string(),
  /** Whether the message has been fully handled (e.g. artifact provided, or blocked) */
  handled: z.boolean().default(false),
  /** Number of hops/exchanges in this thread (used for escalation limits) */
  hopCount: z.number().int().nonnegative().default(0),
  /** Optional conversation/reply ID for threading */
  replyToId: z.string().optional(),
  createdAt: z.string().datetime(),
});

export type TaskMessage = z.infer<typeof TaskMessageSchema>;
