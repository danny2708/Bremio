import { z } from "zod";

export const ContextItemTypeSchema = z.enum([
  "file",
  "folder",
  "selection",
  "image",
  "url",
  "terminal",
  "diff",
  "note",
]);

export const ContextItemScopeSchema = z.enum(["message", "turn", "session"]);

export const ContextItemSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  type: ContextItemTypeSchema,
  source: z.string(),
  addedAt: z.string(),
  scope: ContextItemScopeSchema,
  tokensEstimated: z.number().int().nonnegative().optional(),
  enabled: z.boolean(),
});

export type ContextItem = z.infer<typeof ContextItemSchema>;
export type ContextItemType = z.infer<typeof ContextItemTypeSchema>;
export type ContextItemScope = z.infer<typeof ContextItemScopeSchema>;
