import { simpleGit, type SimpleGit } from "simple-git";

/**
 * Git operations Bremio performs on the user's behalf (Sprint 10).
 *
 * Separate from `MergeManager`, which owns the worktree lifecycle. These are
 * the everyday operations a person does to their own repository: see what
 * changed, stage some of it, commit, move between branches.
 *
 * `docs/15` §2.4.1 classifies each of these as an `ActionClass`. That
 * classification governs an **agent** performing them. Everything here is
 * driven by the user clicking a button in their own repository, so there is no
 * control mode to evaluate against — the same way apply and revert have always
 * worked. When an agent is given these operations, `gitActionClasses()` in
 * `@bremio/policy` is the table it must consult first.
 */

/** One path in the working tree, and what happened to it. */
export interface WorkingTreeEntry {
  path: string;
  /** Index status: what is staged for the next commit. */
  staged: boolean;
  /** Working-tree status letter from `git status --porcelain` (M, D, A, ?…). */
  status: string;
  /** `?` in porcelain: never seen by git before. */
  untracked: boolean;
}

export interface WorkingTreeState {
  branch?: string;
  detached: boolean;
  entries: WorkingTreeEntry[];
}

export class GitOpsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitOpsError";
  }
}

function describe(letter: string): string {
  switch (letter) {
    case "M": return "modified";
    case "A": return "added";
    case "D": return "deleted";
    case "R": return "renamed";
    case "C": return "copied";
    case "U": return "unmerged";
    case "?": return "untracked";
    default: return letter.trim() || "changed";
  }
}

export class GitOps {
  private readonly git: SimpleGit;

  constructor(private readonly repoPath: string) {
    this.git = simpleGit(repoPath);
  }

  /**
   * What is changed in the working tree, staged and unstaged separately.
   *
   * Parsed from `--porcelain=v1 -z` rather than simple-git's summary because
   * the index and worktree columns have to stay distinct: a file can be both
   * staged and modified again since, and collapsing that would make the panel
   * offer to commit content the user has already superseded.
   */
  async status(): Promise<WorkingTreeState> {
    const raw = await this.git.raw(["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    const entries: WorkingTreeEntry[] = [];

    // -z output is NUL-separated; a rename carries a second NUL-separated path
    // that must be consumed, or it is read as a bogus entry of its own.
    const parts = raw.split("\0");
    for (let i = 0; i < parts.length; i++) {
      const record = parts[i];
      if (!record || record.length < 3) continue;
      const index = record[0]!;
      const worktree = record[1]!;
      const filePath = record.slice(3);
      if (index === "R" || index === "C") i += 1;

      const untracked = index === "?" || worktree === "?";
      if (index !== " " && index !== "?") {
        entries.push({ path: filePath, staged: true, status: describe(index), untracked: false });
      }
      if (worktree !== " " && worktree !== "?") {
        entries.push({ path: filePath, staged: false, status: describe(worktree), untracked: false });
      }
      if (untracked) {
        entries.push({ path: filePath, staged: false, status: "untracked", untracked: true });
      }
    }

    const branch = (await this.git.revparse(["--abbrev-ref", "HEAD"])).trim();
    return {
      detached: branch === "HEAD",
      ...(branch === "HEAD" ? {} : { branch }),
      entries,
    };
  }

  /**
   * Stage exactly the paths given.
   *
   * **Never `git add -A`.** The S5 review removed precisely that call from the
   * diff computation, where it silently flattened a user's partially staged
   * index — work they had chosen to separate, merged back together with no
   * record of what had been staged. Staging is the one place it would be most
   * tempting to reintroduce, and the damage would be identical.
   */
  async stage(paths: readonly string[]): Promise<void> {
    if (paths.length === 0) throw new GitOpsError("no paths given to stage");
    await this.git.raw(["add", "--", ...paths]);
  }

  /** Remove paths from the index, leaving the working tree untouched. */
  async unstage(paths: readonly string[]): Promise<void> {
    if (paths.length === 0) throw new GitOpsError("no paths given to unstage");
    await this.git.raw(["restore", "--staged", "--", ...paths]);
  }

  /**
   * Commit what is staged.
   *
   * Refuses an empty index rather than creating an empty commit: a commit that
   * records nothing is a lie in the history, and the user pressing the button
   * meant to commit something.
   */
  async commit(message: string): Promise<{ hash: string; summary: string }> {
    if (!message.trim()) throw new GitOpsError("a commit message is required");

    const staged = (await this.git.raw(["diff", "--cached", "--name-only"])).trim();
    if (!staged) {
      throw new GitOpsError("nothing is staged — stage the changes you want to commit first");
    }

    const result = await this.git.commit(message);
    return {
      hash: result.commit,
      summary: `${result.summary.changes} file(s), +${result.summary.insertions} -${result.summary.deletions}`,
    };
  }
}
