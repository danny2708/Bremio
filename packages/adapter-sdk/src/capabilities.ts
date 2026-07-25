import { z } from "zod";

/**
 * AgentCapabilities — what an adapter can do. Capabilities decide an agent's
 * role, never the provider name (docs/01, core concept 3). The router maps
 * a task's `requiredCapabilities` tokens onto these booleans.
 *
 * An adapter with `planning === true` and `structuredOutput === true` is
 * eligible to be the lead.
 */
/**
 * How read-only enforcement is achieved at the transport level.
 * Only `"advisory"` and `"unsupported"` are not acceptable backings for
 * `plan` or `approve` control modes.
 */
export const ReadOnlyEnforcementSchema = z.enum([
  "hard-sandbox",
  "provider-native",
  "worktree-contained",
  "advisory",
  "unsupported",
]);
export type ReadOnlyEnforcement = z.infer<typeof ReadOnlyEnforcementSchema>;

export const AgentCapabilitiesSchema = z.object({
  planning: z.boolean(),
  structuredOutput: z.boolean(),
  repositoryRead: z.boolean(),
  repositoryWrite: z.boolean(),
  shell: z.boolean(),
  testing: z.boolean(),
  browser: z.boolean(),
  vision: z.boolean(),
  resumableSessions: z.boolean(),
  readOnlyEnforcement: ReadOnlyEnforcementSchema,
});
export type AgentCapabilities = z.infer<typeof AgentCapabilitiesSchema>;

/** Roles an agent profile can take on within a run. */
export const AgentRoleSchema = z.enum([
  "lead",
  "planner",
  "implementer",
  "reviewer",
  "tester",
]);
export type AgentRole = z.infer<typeof AgentRoleSchema>;

/**
 * Permission granted to a task's run. A reviewer gets `read-only`; an
 * implementer gets `workspace-write` (docs/03). Enforcement strength is
 * per-provider (see docs/04).
 */
export const PermissionSchema = z.enum(["read-only", "workspace-write"]);
export type Permission = z.infer<typeof PermissionSchema>;
