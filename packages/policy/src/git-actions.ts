import type { ActionClass } from "./policy";

/**
 * Git operations Bremio can perform on the user's behalf (Sprint 10).
 *
 * Read-only inspection is deliberately absent from the destructive end: `status`
 * and `diff` are as ordinary as reading a file.
 */
export type GitOperation =
  | "status"
  | "diff"
  | "log"
  | "list-branches"
  | "stage"
  | "commit"
  | "create-branch"
  | "switch-branch"
  | "fetch"
  | "pull"
  | "push"
  | "force-push"
  | "rewrite-history"
  | "open-pull-request";

/**
 * The action class each git operation is evaluated as (`docs/15` §2.4.1).
 *
 * This exists as data rather than as a table in the document because four
 * separate tasks (S10-T10…T13) need the same answer, and a rule that lives only
 * in prose is the comment-only enforcement this codebase keeps having to fix —
 * §2.2's backing rule was a doc comment until the S2 review made it executable,
 * and the autopilot deny list was prose until S3-T8.
 *
 * Some operations are genuinely two classes at once. `pull` reaches the network
 * *and* can fast-forward the working tree, so a caller must satisfy both; the
 * mapping returns every class that applies rather than picking the scarier one,
 * because a caller that checks only `network` would let a pull write in plan
 * mode.
 */
const GIT_ACTION_CLASSES: Record<GitOperation, readonly ActionClass[]> = {
  status: ["read"],
  diff: ["read"],
  log: ["read"],
  "list-branches": ["read"],

  stage: ["write"],
  commit: ["write"],
  "create-branch": ["write"],
  "switch-branch": ["write"],

  // Network *and* write: it can move the working tree under the user.
  fetch: ["network"],
  pull: ["network", "write"],
  push: ["network"],

  // Denied under autopilot with nothing left to override it — the grant
  // lifecycle was deleted in S5-T7 and S6-T4. A refusal is the only correct
  // outcome; downgrading a force-push to a push substitutes a different
  // operation for the one that was asked for.
  "force-push": ["git-destructive", "network"],
  "rewrite-history": ["git-destructive"],

  "open-pull-request": ["network"],
};

/** Every action class a git operation must be permitted to perform. */
export function gitActionClasses(operation: GitOperation): readonly ActionClass[] {
  const classes = GIT_ACTION_CLASSES[operation];
  if (!classes) throw new Error(`unknown git operation: ${operation}`);
  return classes;
}

/**
 * True when this operation can never run under autopilot.
 *
 * A convenience over `gitActionClasses`, so a caller does not have to remember
 * which classes §2.5 denies.
 */
export function isAutopilotDenied(operation: GitOperation): boolean {
  return gitActionClasses(operation).includes("git-destructive");
}
