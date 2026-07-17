import { promises as fs } from "node:fs";
import path from "node:path";
import { simpleGit, type SimpleGit } from "simple-git";

/** A git worktree dedicated to one task. */
export interface TaskWorktree {
  taskId: string;
  agentId: string;
  /** Branch name, e.g. `bremio/TASK-002-codex`. */
  branch: string;
  /** Absolute path to the worktree directory. */
  path: string;
}

export interface CollectResult {
  filesChanged: string[];
  commitHash?: string;
  committed: boolean;
}

export interface WorktreeManagerOptions {
  /** Short token (from the run id) used to de-collide branch names on reruns. */
  runToken: string;
}

/**
 * WorktreeManager — isolates every task in its own git worktree + branch under
 * `<repo>/.bremio/worktrees/`. Collects the diff (by committing on the task's
 * branch) and leaves the worktree in place for manual review (NO auto-merge).
 */
export class WorktreeManager {
  private readonly repo: SimpleGit;
  private readonly worktreesRoot: string;
  private readonly runToken: string;

  constructor(
    private readonly repoPath: string,
    options: WorktreeManagerOptions,
  ) {
    this.repo = simpleGit(repoPath);
    this.worktreesRoot = path.join(repoPath, ".bremio", "worktrees");
    this.runToken = options.runToken;
  }

  /** Verify the target directory is a git repo with at least one commit. */
  async assertUsable(): Promise<void> {
    const isRepo = await this.repo.checkIsRepo();
    if (!isRepo) {
      throw new Error(`${this.repoPath} is not a git repository`);
    }
    try {
      await this.repo.revparse(["HEAD"]);
    } catch {
      throw new Error(
        `${this.repoPath} has no commits yet; make an initial commit before running Bremio`,
      );
    }
  }

  /**
   * Create a branch + worktree for a task. Uses the doc-canonical name
   * `bremio/<taskId>-<agentId>`; if that branch already exists (rerun), appends
   * the run token so prior worktrees are never clobbered.
   */
  async create(
    taskId: string,
    agentId: string,
    baseRef = "HEAD",
  ): Promise<TaskWorktree> {
    const leaf = `${taskId}-${agentId}`;
    let branch = `bremio/${leaf}`;
    let dirLeaf = leaf;

    const existing = await this.repo.branchLocal();
    if (existing.all.includes(branch)) {
      dirLeaf = `${leaf}-${this.runToken}`;
      branch = `bremio/${dirLeaf}`;
    }

    const dir = path.join(this.worktreesRoot, dirLeaf);
    await fs.mkdir(this.worktreesRoot, { recursive: true });
    await this.repo.raw(["worktree", "add", "-b", branch, dir, baseRef]);

    return { taskId, agentId, branch, path: dir };
  }

  /**
   * Stage everything the agent changed and commit it on the task branch, so the
   * change is captured with a hash and reviewable via git. Returns the changed
   * files; commits only when there is something to commit.
   */
  async collect(wt: TaskWorktree): Promise<CollectResult> {
    const git = simpleGit(wt.path);
    await git.add(["-A"]);
    const staged = (await git.diff(["--cached", "--name-only"]))
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);

    if (staged.length === 0) {
      return { filesChanged: [], committed: false };
    }

    // --no-verify: don't let the target repo's hooks block the capture commit.
    await git.commit(`bremio: ${wt.taskId} (${wt.agentId})`, undefined, {
      "--no-verify": null,
    });
    const commitHash = (await git.revparse(["HEAD"])).trim();
    return { filesChanged: staged, commitHash, committed: true };
  }

  /**
   * Remove a worktree and its branch. Phase 1 does NOT call this (worktrees are
   * left for manual review); provided for cleanup/tests.
   */
  async remove(wt: TaskWorktree): Promise<void> {
    await this.repo.raw(["worktree", "remove", "--force", wt.path]);
    try {
      await this.repo.deleteLocalBranch(wt.branch, true);
    } catch {
      // branch may already be gone; ignore.
    }
  }
}
