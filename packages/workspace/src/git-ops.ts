import { execFile } from "node:child_process";
import { simpleGit, type SimpleGit } from "simple-git";

export type GhRunner = (args: string[], cwd: string) => Promise<{ stdout: string; stderr: string }>;

const defaultGhRunner: GhRunner = async (args: string[], cwd: string) => {
  return new Promise((resolve, reject) => {
    execFile("gh", args, { cwd }, (err, stdout, stderr) => {
      if (err) {
        const error = new Error(stderr.trim() || stdout.trim() || err.message);
        (error as unknown as { code?: string | number }).code = (err as unknown as { code?: string | number }).code;
        return reject(error);
      }
      resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
};

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

  constructor(
    private readonly repoPath: string,
    private readonly ghRunner: GhRunner = defaultGhRunner,
  ) {
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

  /** Local branches, newest commit first, with the checked-out one marked. */
  async branches(): Promise<Array<{ name: string; current: boolean }>> {
    const raw = await this.git.raw([
      "for-each-ref",
      "--sort=-committerdate",
      "--format=%(refname:short)%09%(HEAD)",
      "refs/heads",
    ]);
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [name, head] = line.split("\t");
        return { name: name ?? line, current: head === "*" };
      });
  }

  /**
   * Move to another branch, or refuse and say what is in the way.
   *
   * Git would happily carry uncommitted changes across for many switches, and
   * that is the behaviour to avoid rather than inherit: work started against
   * one branch silently becomes work against another, and the user finds out
   * when they commit it to the wrong place. Refusing names the files, so the
   * next step (commit, stash, discard) is the user's to choose.
   */
  async switchBranch(name: string): Promise<void> {
    if (!name.trim()) throw new GitOpsError("a branch name is required");

    const blocking = (await this.status()).entries
      .filter((entry) => !entry.untracked)
      .map((entry) => entry.path);
    const unique = [...new Set(blocking)];
    if (unique.length > 0) {
      throw new GitOpsError(
        `cannot switch branches with uncommitted changes to ${unique.length} file(s): ` +
          `${unique.slice(0, 5).join(", ")}${unique.length > 5 ? ", …" : ""}. ` +
          "Commit or stash them first.",
      );
    }

    await this.git.raw(["checkout", name]);
  }

  /**
   * Create a branch from the current HEAD and switch to it.
   *
   * Refuses a name that already exists rather than silently switching to it:
   * "create" and "move to the one that is already there" are different
   * intentions, and the second would quietly adopt someone else's history.
   */
  async createBranch(name: string): Promise<void> {
    if (!name.trim()) throw new GitOpsError("a branch name is required");
    if (await this.branchExists(name)) {
      throw new GitOpsError(`branch "${name}" already exists — switch to it instead`);
    }
    await this.git.raw(["checkout", "-b", name]);
  }

  /**
   * Whether a local branch of this name exists.
   *
   * Asks `branches()` rather than `rev-parse --verify --quiet`: with `--quiet`
   * git reports a missing ref by exit code alone and writes nothing to stderr,
   * which simple-git does not surface as a rejection — so the check answered
   * "exists" for every name, including ones it was about to create.
   */
  private async branchExists(name: string): Promise<boolean> {
    return (await this.branches()).some((branch) => branch.name === name);
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

  /** List configured remotes with their fetch and push URLs. */
  async remotes(): Promise<Array<{ name: string; refs: { fetch?: string; push?: string } }>> {
    const remotes = await this.git.getRemotes(true);
    return remotes.map((r) => ({
      name: r.name,
      refs: {
        fetch: r.refs.fetch,
        push: r.refs.push,
      },
    }));
  }

  /**
   * Push changes to a remote repository.
   *
   * **Force-push is git-destructive** (`docs/15` §2.4.1): denied under
   * autopilot and there is no grant mechanism left to override it. A force-push
   * must be refused with a named reason, never quietly downgraded to a normal push.
   */
  async push(options: {
    remote?: string;
    branch?: string;
    setUpstream?: boolean;
    force?: boolean;
  } = {}): Promise<{ remote: string; branch: string; summary: string }> {
    if (options.force) {
      throw new GitOpsError("force-push is git-destructive and denied under autopilot");
    }

    const branch = options.branch ?? (await this.status()).branch;
    if (!branch) {
      throw new GitOpsError("cannot push in detached HEAD state without an explicit branch");
    }

    const remotes = await this.remotes();
    if (remotes.length === 0) {
      throw new GitOpsError("no remote repository configured to push to");
    }

    const remote = options.remote ?? remotes[0]!.name;
    const args = [remote, branch];
    if (options.setUpstream) {
      args.unshift("-u");
    }

    try {
      const result = await this.git.push(args);
      return {
        remote,
        branch,
        summary: result.pushed.length > 0 ? `Pushed ${branch} to ${remote}` : "Everything up-to-date",
      };
    } catch (err) {
      throw new GitOpsError((err as Error).message);
    }
  }

  /**
   * Pull changes from a remote repository.
   *
   * Classified as `network` and `write` (`docs/15` §2.4.1) because it can
   * fast-forward or modify the working tree.
   */
  async pull(options: {
    remote?: string;
    branch?: string;
    rebase?: boolean;
  } = {}): Promise<{ remote: string; branch: string; summary: string }> {
    const branch = options.branch ?? (await this.status()).branch;
    if (!branch) {
      throw new GitOpsError("cannot pull in detached HEAD state without an explicit branch");
    }

    const remotes = await this.remotes();
    if (remotes.length === 0) {
      throw new GitOpsError("no remote repository configured to pull from");
    }

    const remote = options.remote ?? remotes[0]!.name;
    const pullOptions: Record<string, string | null> = {};
    if (options.rebase) {
      pullOptions["--rebase"] = null;
    }

    try {
      const result = await this.git.pull(remote, branch, pullOptions);
      return {
        remote,
        branch,
        summary: result.summary.changes > 0
          ? `${result.summary.changes} file(s) updated (+${result.summary.insertions} -${result.summary.deletions})`
          : "Already up to date.",
      };
    } catch (err) {
      throw new GitOpsError((err as Error).message);
    }
  }

  /**
   * Open a pull request via GitHub CLI (`gh`).
   *
   * Classified as `network` (`docs/15` §2.4.1).
   * Requires GitHub CLI installed, authenticated, and a GitHub remote.
   */
  async createPullRequest(options: {
    title: string;
    body?: string;
    draft?: boolean;
    base?: string;
    head?: string;
  }): Promise<{ url: string }> {
    if (!options.title.trim()) {
      throw new GitOpsError("a pull request title is required");
    }

    const remotes = await this.remotes();
    const hasGitHubRemote = remotes.some((r) =>
      (r.refs.fetch && /github\.com/i.test(r.refs.fetch)) ||
      (r.refs.push && /github\.com/i.test(r.refs.push)),
    );
    if (!hasGitHubRemote) {
      throw new GitOpsError(
        "repository has no GitHub remote configured — cannot create a pull request via GitHub CLI",
      );
    }

    // Verify gh is available and authenticated
    try {
      await this.ghRunner(["auth", "status"], this.repoPath);
    } catch (err) {
      const msg = (err as Error).message;
      if ((err as { code?: string }).code === "ENOENT" || msg.includes("ENOENT") || msg.includes("not recognized")) {
        throw new GitOpsError(
          "GitHub CLI (`gh`) is not installed or not in PATH — install it from https://cli.github.com to create pull requests",
        );
      }
      throw new GitOpsError(
        `GitHub CLI is not authenticated (${msg}) — run 'gh auth login' first`,
      );
    }

    const args = ["pr", "create", "--title", options.title.trim()];
    if (options.body !== undefined) {
      args.push("--body", options.body);
    } else {
      args.push("--body", "");
    }
    if (options.draft) {
      args.push("--draft");
    }
    if (options.base) {
      args.push("--base", options.base);
    }
    if (options.head) {
      args.push("--head", options.head);
    }

    try {
      const { stdout } = await this.ghRunner(args, this.repoPath);
      const url = stdout.trim().split("\n").pop()?.trim() || "";
      if (!url.startsWith("http")) {
        throw new GitOpsError(`unexpected gh pr create output: ${stdout}`);
      }
      return { url };
    } catch (err) {
      if (err instanceof GitOpsError) throw err;
      throw new GitOpsError(`failed to create pull request: ${(err as Error).message}`);
    }
  }
}


