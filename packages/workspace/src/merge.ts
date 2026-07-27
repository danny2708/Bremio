import { mkdirSync, mkdtempSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit, type SimpleGit } from "simple-git";

/** Raised when applying a patch conflicts; the apply is aborted first. */
export class ApplyConflictError extends Error {
  constructor(
    public readonly files: string[],
    public readonly conflictedFiles?: Array<{ file: string; status: string }>,
  ) {
    const detail = conflictedFiles?.length
      ? `conflicts: ${conflictedFiles.map((c) => `${c.file} (${c.status})`).join(", ")}`
      : `conflicts in: ${files.join(", ") || "(unknown files)"}`;
    super(`apply hit ${detail}`);
    this.name = "ApplyConflictError";
  }
}

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

/** Raised when cherry-picking a task commit conflicts; the cherry-pick is aborted first. */
export class CherryPickConflictError extends Error {
  constructor(
    public readonly commit: string,
    public readonly files: string[],
  ) {
    super(
      `cherry-pick of "${commit}" hit conflicts in: ${files.join(", ") || "(unknown files)"}`,
    );
    this.name = "CherryPickConflictError";
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
  private readonly repoPath: string;

  constructor(repoPath: string) {
    this.git = simpleGit(repoPath);
    this.repoPath = repoPath;
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

  /** The task-owned change in one captured commit (excludes inherited dependencies). */
  async getCommitDiff(commit: string): Promise<DiffResult> {
    const stat = await this.git.raw(["show", "--stat", "--format=", commit]);
    const patch = await this.git.raw(["show", "--format=", "--no-ext-diff", commit]);
    return { stat: stat.trim(), patch: patch.trim() };
  }

  /**
   * Merge `branch` into `base`. Requires the main working tree to be ON `base`
   * and clean (we never switch branches or touch uncommitted work behind the
   * user's back). On conflict, aborts the merge and throws MergeConflictError,
   * leaving the repo exactly as it was.
   */
  async merge(branch: string, base: string): Promise<{ mergeCommit: string }> {
    await this.assertIntegrationState(base);

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

  /**
   * Cherry-pick exactly one task-owned commit onto `base`. Dependency commits
   * are intentionally excluded; callers process task commits in plan order.
   */
  async cherryPick(commit: string, base: string): Promise<{ cherryPickCommit: string }> {
    await this.assertIntegrationState(base);

    let cherryPickError: unknown;
    try {
      await this.git.raw(["cherry-pick", commit]);
    } catch (err) {
      cherryPickError = err;
    }

    const conflicted = (await this.git.status()).conflicted;
    if (conflicted.length > 0) {
      try {
        await this.git.raw(["cherry-pick", "--abort"]);
      } catch {
        // best-effort restore
      }
      throw new CherryPickConflictError(commit, conflicted);
    }
    if (cherryPickError) throw cherryPickError;

    const cherryPickCommit = (await this.git.revparse(["HEAD"])).trim();
    return { cherryPickCommit };
  }

  private async assertIntegrationState(base: string): Promise<void> {
    const current = await this.currentBranch();
    if (current !== base) {
      throw new MergeStateError(
        `repository is on "${current}", not the base branch "${base}". Check out "${base}" first (git checkout ${base}).`,
      );
    }
    if (await this.hasTrackedChanges()) {
      throw new MergeStateError(
        "the working tree has uncommitted changes to tracked files. Commit or stash them before integrating task changes.",
      );
    }
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

  /** Require a clean working tree (no uncommitted tracked changes). */
  private async assertCleanTree(): Promise<void> {
    if (await this.hasTrackedChanges()) {
      throw new MergeStateError(
        "the working tree has uncommitted changes to tracked files. Commit or stash them first.",
      );
    }
  }

  /** Write a patch to a temp file and return the path. */
  private writeTempPatch(patch: string): string {
    const dir = mkdtempSync(join(tmpdir(), "bremio-patch-"));
    const file = join(dir, "patch.diff");
    writeFileSync(file, patch, "utf8");
    return file;
  }

  /**
   * Run `git apply` with a temp patch file.
   *
   * No conflict handling here: plain `git apply` is all-or-nothing, so it never
   * leaves conflict markers or a half-applied tree to clean up. (This did
   * inspect `status().conflicted` and call `git apply --abort` — a subcommand
   * that does not exist — which read as a safety net that could never fire.)
   * Conflicts are caught up front by `detectConflicts`.
   */
  private async runApply(args: string[], patch: string): Promise<{ output: string }> {
    const tmpFile = this.writeTempPatch(patch);
    try {
      const output = await this.git.raw([...args, tmpFile]);
      return { output: output.trim() };
    } finally {
      try {
        unlinkSync(tmpFile);
      } catch {
        // best-effort cleanup
      }
    }
  }

  /**
   * Extract the list of files touched by a unified diff patch.
   */
  extractPatchFiles(patch: string): string[] {
    const files: string[] = [];
    for (const line of patch.split("\n")) {
      const file = patchHeaderPath(line);
      if (file) files.push(file);
    }
    return files;
  }

  /**
   * Check which files from a patch have user changes in the working tree
   * (modified, deleted, or untracked) that would make clean application fail.
   * Returns an empty array when no conflicts are expected.
   */
  async detectConflicts(patch: string): Promise<Array<{ file: string; status: string }>> {
    const patchFiles = this.extractPatchFiles(patch);
    if (patchFiles.length === 0) return [];

    const s = await this.git.status();
    const userChanges = new Map<string, string>();

    for (const f of s.modified) userChanges.set(f, "user_modified");
    for (const f of s.deleted) userChanges.set(f, "user_deleted");
    for (const f of s.created) userChanges.set(f, "user_added");
    // `created` is *staged* new files. A file the user created and never staged
    // is in `not_added`, and was invisible here — so a patch that creates the
    // same path reported no conflict and then died on a bare "already exists".
    for (const f of s.not_added) userChanges.set(f, "user_added");
    // `created` is *staged* new files. A file the user created and never staged
    // is in `not_added`, and was invisible here — so a patch that creates the
    // same path reported no conflict and then died on a bare "already exists".

    const conflicts: Array<{ file: string; status: string }> = [];
    for (const pf of patchFiles) {
      const userStatus = userChanges.get(pf);
      if (userStatus) {
        conflicts.push({ file: pf, status: userStatus });
      }
    }
    return conflicts;
  }

  /**
   * Save what `--force` is about to overwrite, so it is recoverable.
   *
   * `git checkout HEAD -- <file>` is unrecoverable: uncommitted work is simply
   * gone, and no reflog or stash records it. Returns the patch's path, or
   * undefined when there was nothing to save.
   */
  private async saveRecoveryPatch(files: string[]): Promise<string | undefined> {
    const patch = await this.git.raw(["diff", "HEAD", "--", ...files]).catch(() => "");
    if (!patch.trim()) return undefined;
    const dir = join(this.repoPath, ".bremio", "recovery");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `force-${new Date().toISOString().replace(/[:.]/g, "-")}.patch`);
    writeFileSync(file, patch, "utf8");
    return file;
  }

  /**
   * Make the working tree safe for a patch, or refuse.
   *
   * The clean-tree requirement is deliberately scoped. It used to cover the
   * whole repository, which meant any unrelated dirty file blocked an apply —
   * including under `--force`, whose own error message promises otherwise, and
   * which only ever reset the *conflicting* files. Files the patch does not
   * touch are the user's business. The one exception is a patch with no
   * `diff --git` headers: there is no way to tell what it touches, so the whole
   * tree is the only honest scope.
   */
  private async prepareWorkingTree(
    patch: string,
    force: boolean | undefined,
  ): Promise<{ recoveryPatch?: string }> {
    const conflicts = await this.detectConflicts(patch);
    let recoveryPatch: string | undefined;

    if (conflicts.length > 0) {
      if (!force) {
        throw new ApplyConflictError(
          conflicts.map((c) => c.file),
          conflicts,
        );
      }
      const untracked = conflicts.filter((c) => c.status === "user_added");
      if (untracked.length > 0) {
        // `git checkout HEAD -- <path>` cannot restore a path that is not in
        // HEAD. This failed silently and left the file for `git apply` to trip
        // over with a bare "already exists".
        throw new MergeStateError(
          `cannot force over untracked file(s): ${untracked.map((c) => c.file).join(", ")}. ` +
            "Commit, move or delete them first.",
        );
      }
      recoveryPatch = await this.saveRecoveryPatch(conflicts.map((c) => c.file));
      for (const c of conflicts) {
        await this.git.raw(["checkout", "HEAD", "--", c.file]);
      }
    }

    if (this.extractPatchFiles(patch).length === 0) await this.assertCleanTree();
    return recoveryPatch ? { recoveryPatch } : {};
  }

  /**
   * Apply a unified diff patch to the working tree via `git apply`.
   * When `force` is true, resets any conflicting files to HEAD before applying,
   * overwriting user modifications with the agent's version — a copy of what is
   * overwritten is saved and returned as `recoveryPatch`.
   */
  async applyPatch(
    patch: string,
    options?: { force?: boolean },
  ): Promise<{ output: string; recoveryPatch?: string }> {
    const { recoveryPatch } = await this.prepareWorkingTree(patch, options?.force);
    const { output } = await this.runApply(["apply"], patch);
    return recoveryPatch ? { output, recoveryPatch } : { output };
  }

  /**
   * Reverse-apply a unified diff (revert changes) via `git apply --reverse`.
   * Same force semantics as `applyPatch`.
   */
  async revertPatch(
    patch: string,
    options?: { force?: boolean },
  ): Promise<{ output: string; recoveryPatch?: string }> {
    const { recoveryPatch } = await this.prepareWorkingTree(patch, options?.force);
    const { output } = await this.runApply(["apply", "--reverse"], patch);
    return recoveryPatch ? { output, recoveryPatch } : { output };
  }

  /**
   * Extract the hunks for a single file from a unified diff patch.
   * Returns a patch that applies only to that file, or empty string if
   * the file is not mentioned in the patch.
   */
  extractFilePatch(patch: string, filePath: string): string {
    const normalizedPath = filePath.replace(/\\/g, "/");
    const lines = patch.split("\n");
    const result: string[] = [];
    let inTarget = false;

    for (const line of lines) {
      if (line.startsWith("diff --git ")) {
        // Compare the parsed path, not `line.includes(path)`: a substring test
        // makes "app.ts" select "src/app.ts.bak" and "myapp.ts" as well.
        inTarget = patchHeaderPath(line) === normalizedPath;
      }
      if (inTarget) {
        result.push(line);
      }
    }

    // Remove the trailing empty line if present
    while (result.length > 0 && result[result.length - 1] === "") {
      result.pop();
    }
    // git apply requires a trailing newline
    return result.join("\n") + (result.length > 0 ? "\n" : "");
  }
}

/**
 * The post-image path of a `diff --git a/<x> b/<y>` line, or undefined.
 *
 * Splitting on whitespace loses paths containing spaces, so the `b/` marker is
 * located instead: git writes both paths, and the second one starts at the
 * ` b/` that is followed by the rest of the line.
 */
function patchHeaderPath(line: string): string | undefined {
  if (!line.startsWith("diff --git ")) return undefined;
  const rest = line.slice("diff --git ".length);
  if (!rest.startsWith("a/")) return undefined;
  // `a/<path> b/<path>` — the same path appears twice, so the split point is
  // the midpoint marker " b/" that leaves equal-length halves.
  const marker = " b/";
  for (let i = rest.indexOf(marker); i !== -1; i = rest.indexOf(marker, i + 1)) {
    const before = rest.slice(2, i);
    const after = rest.slice(i + marker.length);
    if (before === after) return after;
  }
  // Renames and other cases where the two paths differ: take the last " b/".
  const last = rest.lastIndexOf(marker);
  return last === -1 ? undefined : rest.slice(last + marker.length);
}

/** Resolve a repo's current branch name (used to record a run's base branch). */
export async function getCurrentBranch(repoPath: string): Promise<string> {
  return (await simpleGit(repoPath).revparse(["--abbrev-ref", "HEAD"])).trim();
}
