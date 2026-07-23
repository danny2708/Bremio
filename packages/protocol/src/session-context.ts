import { z } from "zod";

export const SessionContextSchema = z.object({
  sessionId: z.string(),
  turnIndex: z.number().int().nonnegative(),
  summary: z.string().optional(),
  providerSessionIds: z.record(z.string(), z.string()).optional(),
  createdAt: z.string(),
});

export type SessionContext = z.infer<typeof SessionContextSchema>;
