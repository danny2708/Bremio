import { z } from "zod";

/** Runtime modes implemented today. Auto is a future policy, not an engine. */
export const ExecutionModeSchema = z.enum(["single", "team"]);
export type ExecutionMode = z.infer<typeof ExecutionModeSchema>;
