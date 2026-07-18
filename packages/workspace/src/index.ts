/**
 * @bremio/workspace — git worktree isolation per task, plus per-task log files.
 * One worktree per task under `<repo>/.bremio/worktrees/`; the diff is captured
 * by committing on the task branch and the worktree is left for manual review.
 */
export {
  WorktreeManager,
  type TaskWorktree,
  type CollectResult,
  type WorktreeManagerOptions,
} from "./worktree";

export { TaskLog, formatEvent } from "./logs";

export {
  MergeManager,
  MergeConflictError,
  CherryPickConflictError,
  MergeStateError,
  getCurrentBranch,
  type DiffResult,
} from "./merge";
