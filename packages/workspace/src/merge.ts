import { simpleGit, type SimpleGit } from "simple-git";

/** Raised when merging a task branch hits conflicts; the merge is aborted first. */
export class MergeConflictError extends Error {
  constructor(
    public readonly branch: string,
    public readonly files: string[],
  ) {
    super(
      `merge of "${branch}" hit conflicts in: ${files.join(", ") || "(unknown files)"}`,
    );
    this.name = "MergeConflictError";
  }
}

/** Raised for pre-flight problems that make a merge unsafe (dirty tree, wrong branch). */
export class MergeStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MergeStateError";
  }
}

export interface DiffResult {
  stat: string;
  patch: string;
}

/**
 * MergeManager — the merge/cleanup half of the worktree lifecycle (docs/03).
 * Merges a task branch into the base branch it was cut from, always with a
 * merge commit (`--no-ff`) for a clear "Bremio merged this" record, aborting
 * cleanly on conflict. Never merges silently — the CLI gates every merge behind
 * confirmation; this class only performs the git work.
 */
export class MergeManager {
  private readonly git: SimpleGit;

  constructor(repoPath: string) {
    this.git = simpleGit(repoPath);
  }

  /** Current branch of the main working tree, or "HEAD" when detached. */
  async currentBranch(): Promise<string> {
    return (await this.git.revparse(["--abbrev-ref", "HEAD"])).trim();
  }

  async isClean(): Promise<boolean> {
    return (await this.git.status()).isClean();
  }

  /**
   * Whether the working tree has uncommitted changes to *tracked* files
   * (staged/modified/deleted/renamed/conflicted). Untracked files are ignored —
   * they don't affect a merge, and Bremio's own `.bremio/` would otherwise
   * block every merge.
   */
  async hasTrackedChanges(): Promise<boolean> {
    const s = await this.git.status();
    return (
      s.staged.length > 0 ||
      s.modified.length > 0 ||
      s.deleted.length > 0 ||
      s.created.length > 0 ||
      s.renamed.length > 0 ||
      s.conflicted.length > 0
    );
  }

  async branchExists(branch: string): Promise<boolean> {
    return (await this.git.branchLocal()).all.includes(branch);
  }

  /** Number of commits on `branch` not yet in `base` (0 = nothing to merge). */
  async commitsAhead(branch: string, base: string): Promise<number> {
    const out = (await this.git.raw(["rev-list", "--count", `${base}..${branch}`])).trim();
    return Number.parseInt(out, 10) || 0;
  }

  /** The change `branch` introduces relative to `base` (three-dot diff). */
  async getDiff(branch: string, base: string): Promise<DiffResult> {
    const range = `${base}...${branch}`;
    const stat = await this.git.raw(["diff", "--stat", range]);
    const patch = await this.git.raw(["diff", range]);
    return { stat: stat.trim(), patch: patch.trim() };
  }

  /**
   * Merge `branch` into `base`. Requires the main working tree to be ON `base`
   * and clean (we never switch branches or touch uncommitted work behind the
   * user's back). On conflict, aborts the merge and throws MergeConflictError,
   * leaving the repo exactly as it was.
   */
  async merge(branch: string, base: string): Promise<{ mergeCommit: string }> {
    const current = await this.currentBranch();
    if (current !== base) {
      throw new MergeStateError(
        `repository is on "${current}", not the base branch "${base}". Check out "${base}" first (git checkout ${base}).`,
      );
    }
    if (await this.hasTrackedChanges()) {
      throw new MergeStateError(
        "the working tree has uncommitted changes to tracked files. Commit or stash them before merging.",
      );
    }

    // NOTE: simple-git's `.raw(["merge", ...])` resolves (does NOT throw) on a
    // merge conflict — it just returns the "CONFLICT" text. So we detect
    // conflicts via `status.conflicted`, not via a thrown error.
    let mergeError: unknown;
    try {
      await this.git.raw(["merge", "--no-ff", "-m", `bremio: merge ${branch}`, branch]);
    } catch (err) {
      mergeError = err;
    }

    const conflicted = (await this.git.status()).conflicted;
    if (conflicted.length > 0) {
      try {
        await this.git.raw(["merge", "--abort"]);
      } catch {
        // best-effort restore
      }
      throw new MergeConflictError(branch, conflicted);
    }
    if (mergeError) throw mergeError; // a genuine merge failure, not a conflict

    const mergeCommit = (await this.git.revparse(["HEAD"])).trim();
    return { mergeCommit };
  }

  /** Remove a task's worktree and delete its (now-merged) branch. */
  async cleanup(worktreePath: string, branch: string): Promise<void> {
    try {
      await this.git.raw(["worktree", "remove", "--force", worktreePath]);
    } catch {
      // worktree may already be gone
    }
    try {
      await this.git.deleteLocalBranch(branch, true);
    } catch {
      // branch may already be gone
    }
  }
}

/** Resolve a repo's current branch name (used to record a run's base branch). */
export async function getCurrentBranch(repoPath: string): Promise<string> {
  return (await simpleGit(repoPath).revparse(["--abbrev-ref", "HEAD"])).trim();
}
