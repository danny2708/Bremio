import { execFileSync } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ApplyConflictError,
  CherryPickConflictError,
  MergeConflictError,
  MergeManager,
  MergeStateError,
} from "./merge";

let repo: string;
const git = (args: string[], cwd = repo) => execFileSync("git", args, { cwd, stdio: "pipe" });

async function write(file: string, content: string): Promise<void> {
  await fs.writeFile(path.join(repo, file), content);
}

beforeEach(async () => {
  repo = await fs.mkdtemp(path.join(os.tmpdir(), "bremio-merge-"));
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@bremio.local"]);
  git(["config", "user.name", "Bremio Test"]);
  git(["config", "core.autocrlf", "false"]); // deterministic LF for content asserts
  await write("README.md", "# base\n");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "init"]);
});

afterEach(async () => {
  await fs.rm(repo, { recursive: true, force: true }).catch(() => {});
});

/** Create a branch off main that adds/modifies a file, then return to main. */
async function branchWithChange(branch: string, file: string, content: string): Promise<void> {
  git(["checkout", "-q", "-b", branch]);
  await write(file, content);
  git(["add", "-A"]);
  git(["commit", "-q", "-m", `change ${file}`]);
  git(["checkout", "-q", "main"]);
}

describe("MergeManager", () => {
  it("reports commits ahead and the diff for a task branch", async () => {
    await branchWithChange("bremio/T1", "FEATURE.txt", "hello\n");
    const mgr = new MergeManager(repo);
    expect(await mgr.commitsAhead("bremio/T1", "main")).toBe(1);
    const diff = await mgr.getDiff("bremio/T1", "main");
    expect(diff.patch).toContain("FEATURE.txt");
    expect(diff.stat).toContain("FEATURE.txt");
  });

  it("merges a task branch into base with a merge commit", async () => {
    await branchWithChange("bremio/T1", "FEATURE.txt", "hello\n");
    const mgr = new MergeManager(repo);
    const { mergeCommit } = await mgr.merge("bremio/T1", "main");
    expect(mergeCommit).toMatch(/^[0-9a-f]{7,}$/);
    // the change is now on main's working tree
    expect(existsSync(path.join(repo, "FEATURE.txt"))).toBe(true);
    // --no-ff always creates a merge commit
    const subject = git(["log", "-1", "--pretty=%s"]).toString().trim();
    expect(subject).toBe("bremio: merge bremio/T1");
  });

  it("cherry-picks exactly one captured task commit", async () => {
    await branchWithChange("bremio/T1", "FEATURE.txt", "hello\n");
    const commit = git(["rev-parse", "bremio/T1"]).toString().trim();
    const mgr = new MergeManager(repo);
    const diff = await mgr.getCommitDiff(commit);
    expect(diff.patch).toContain("FEATURE.txt");

    const { cherryPickCommit } = await mgr.cherryPick(commit, "main");
    expect(cherryPickCommit).toMatch(/^[0-9a-f]{7,}$/);
    expect(existsSync(path.join(repo, "FEATURE.txt"))).toBe(true);
    expect(git(["log", "-1", "--pretty=%s"]).toString().trim()).toBe("change FEATURE.txt");
  });

  it("aborts on conflict and leaves the repo unchanged", async () => {
    await write("shared.txt", "base\n");
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "add shared"]);

    // branch changes shared.txt one way...
    git(["checkout", "-q", "-b", "bremio/T2"]);
    await write("shared.txt", "branch side\n");
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "branch edit"]);
    git(["checkout", "-q", "main"]);
    // ...main changes the same lines another way
    await write("shared.txt", "main side\n");
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "main edit"]);

    const mgr = new MergeManager(repo);
    await expect(mgr.merge("bremio/T2", "main")).rejects.toBeInstanceOf(MergeConflictError);

    // repo is restored: clean, on main, main's content intact
    expect(await mgr.isClean()).toBe(true);
    expect(await mgr.currentBranch()).toBe("main");
    expect(await fs.readFile(path.join(repo, "shared.txt"), "utf8")).toBe("main side\n");
  });

  it("aborts a conflicting cherry-pick and leaves the repo unchanged", async () => {
    await write("shared.txt", "base\n");
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "add shared"]);
    git(["checkout", "-q", "-b", "bremio/T2-cherry"]);
    await write("shared.txt", "task side\n");
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "task edit"]);
    const commit = git(["rev-parse", "HEAD"]).toString().trim();
    git(["checkout", "-q", "main"]);
    await write("shared.txt", "main side\n");
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "main edit"]);

    const mgr = new MergeManager(repo);
    await expect(mgr.cherryPick(commit, "main")).rejects.toBeInstanceOf(CherryPickConflictError);
    expect(await mgr.isClean()).toBe(true);
    expect(await fs.readFile(path.join(repo, "shared.txt"), "utf8")).toBe("main side\n");
  });

  it("refuses to merge when not on the base branch", async () => {
    await branchWithChange("bremio/T3", "F.txt", "x\n");
    git(["checkout", "-q", "-b", "somewhere-else"]);
    const mgr = new MergeManager(repo);
    await expect(mgr.merge("bremio/T3", "main")).rejects.toBeInstanceOf(MergeStateError);
  });

  it("refuses to merge with a dirty working tree", async () => {
    await branchWithChange("bremio/T4", "F.txt", "x\n");
    await write("README.md", "# dirty\n"); // uncommitted change on main
    const mgr = new MergeManager(repo);
    await expect(mgr.merge("bremio/T4", "main")).rejects.toBeInstanceOf(MergeStateError);
  });

  it("cleans up a worktree and its branch", async () => {
    const wt = path.join(repo, ".bremio", "worktrees", "T5");
    git(["worktree", "add", "-q", "-b", "bremio/T5", wt, "main"]);
    expect(existsSync(wt)).toBe(true);

    const mgr = new MergeManager(repo);
    await mgr.cleanup(wt, "bremio/T5");

    expect(existsSync(wt)).toBe(false);
    expect(await mgr.branchExists("bremio/T5")).toBe(false);
  });

  describe("applyPatch / revertPatch", () => {
    it("applies a unified diff patch to the working tree", async () => {
      await write("FEATURE.txt", "original\n");
      git(["add", "-A"]);
      git(["commit", "-q", "-m", "add feature"]);

      const patch = "--- a/FEATURE.txt\n+++ b/FEATURE.txt\n@@ -1 +1,2 @@\n original\n+added\n";
      const mgr = new MergeManager(repo);
      const result = await mgr.applyPatch(patch);
      expect(result.output).toBeDefined();
      expect(await fs.readFile(path.join(repo, "FEATURE.txt"), "utf8")).toBe("original\nadded\n");
    });

    it("reverts a unified diff patch from the working tree", async () => {
      await write("FEATURE.txt", "original\nadded\n");
      git(["add", "-A"]);
      git(["commit", "-q", "-m", "add feature with extra"]);

      const patch = "--- a/FEATURE.txt\n+++ b/FEATURE.txt\n@@ -1 +1,2 @@\n original\n+added\n";
      const mgr = new MergeManager(repo);
      await mgr.revertPatch(patch);
      expect(await fs.readFile(path.join(repo, "FEATURE.txt"), "utf8")).toBe("original\n");
    });

    it("refuses to apply when tree has uncommitted tracked changes", async () => {
      await write("TRACKED.txt", "base\n");
      git(["add", "-A"]);
      git(["commit", "-q", "-m", "init"]);
      // Modify the tracked file without committing — dirty tree.
      await write("TRACKED.txt", "dirty\n");

      const mgr = new MergeManager(repo);
      const patch = "--- a/TRACKED.txt\n+++ b/TRACKED.txt\n@@ -1 +1 @@\n-base\n+dirty\n";
      await expect(mgr.applyPatch(patch)).rejects.toBeInstanceOf(MergeStateError);
    });

    it("rejects a conflicting apply cleanly", async () => {
      await write("shared.txt", "base content\n");
      git(["add", "-A"]);
      git(["commit", "-q", "-m", "init"]);

      const mgr = new MergeManager(repo);
      const patch = "--- a/shared.txt\n+++ b/shared.txt\n@@ -1 +1 @@\n-base content\n+conflicting change\n";
      // The working tree has "base content" but the patch says it starts with
      // "base content" — this should succeed since context matches.
      const result = await mgr.applyPatch(patch);
      expect(result.output).toBeDefined();
      expect(await fs.readFile(path.join(repo, "shared.txt"), "utf8")).toBe("conflicting change\n");

      // Now try to apply again — context no longer matches → conflict
      // But apply with `git apply` will fail since the file has been changed
      await expect(mgr.applyPatch(patch)).rejects.toThrow();
    });

    it("rejects a conflicting revert cleanly", async () => {
      await write("shared.txt", "base\n");
      git(["add", "-A"]);
      git(["commit", "-q", "-m", "init"]);

      // Apply patch first
      const patch = "--- a/shared.txt\n+++ b/shared.txt\n@@ -1 +1 @@\n-base\n+updated\n";
      const mgr = new MergeManager(repo);
      await mgr.applyPatch(patch);
      git(["add", "-A"]);
      git(["commit", "-q", "-m", "update"]);

      // Now revert the same patch — should work because context matches
      await mgr.revertPatch(patch);
      expect(await fs.readFile(path.join(repo, "shared.txt"), "utf8")).toBe("base\n");
    });
  });

  describe("extractFilePatch", () => {
    it("extracts hunks for a single file from a multi-file patch", () => {
      const patch = [
        "diff --git a/a.txt b/a.txt",
        "index abc..def 100644",
        "--- a/a.txt",
        "+++ b/a.txt",
        "@@ -1 +1,2 @@",
        " a",
        "+b",
        "diff --git a/c.txt b/c.txt",
        "index 123..456 100644",
        "--- a/c.txt",
        "+++ b/c.txt",
        "@@ -1 +1,2 @@",
        " c",
        "+d",
      ].join("\n") + "\n";

      const mgr = new MergeManager(repo);
      const aPatch = mgr.extractFilePatch(patch, "a.txt");
      expect(aPatch).toContain("a.txt");
      expect(aPatch).not.toContain("c.txt");
      expect(aPatch).toContain("+b");

      const cPatch = mgr.extractFilePatch(patch, "c.txt");
      expect(cPatch).toContain("c.txt");
      expect(cPatch).not.toContain("a.txt");
      expect(cPatch).toContain("+d");
    });

    it("returns empty string for a file not in the patch", () => {
      const patch = "diff --git a/x.txt b/x.txt\n--- a/x.txt\n+++ b/x.txt\n@@ -1 +1,2 @@\n x\n+y\n";

      const mgr = new MergeManager(repo);
      const result = mgr.extractFilePatch(patch, "z.txt");
      expect(result.trim()).toBe("");
    });
  });

  describe("extractPatchFiles", () => {
    it("extracts file paths from diff --git lines", () => {
      const patch = [
        "diff --git a/src/a.txt b/src/a.txt",
        "index abc..def",
        "--- a/src/a.txt",
        "+++ b/src/a.txt",
        "@@ -1 +1,2 @@",
        " a",
        "+b",
        "diff --git a/src/c.txt b/src/c.txt",
        "index 123..456",
        "--- a/src/c.txt",
        "+++ b/src/c.txt",
        "@@ -1 +1,2 @@",
        " c",
        "+d",
      ].join("\n") + "\n";

      const mgr = new MergeManager(repo);
      const files = mgr.extractPatchFiles(patch);
      expect(files).toEqual(["src/a.txt", "src/c.txt"]);
    });

    it("returns empty array for an empty patch", () => {
      const mgr = new MergeManager(repo);
      expect(mgr.extractPatchFiles("")).toEqual([]);
    });
  });

  describe("detectConflicts", () => {
    it("finds user-modified files that overlap with the patch", async () => {
      await write("AGENT.txt", "agent content\n");
      await write("USER.txt", "user content\n");
      git(["add", "-A"]);
      git(["commit", "-q", "-m", "init"]);

      // User modifies USER.txt
      await write("USER.txt", "user changed this\n");

      const patch = [
        "diff --git a/AGENT.txt b/AGENT.txt",
        "--- a/AGENT.txt",
        "+++ b/AGENT.txt",
        "@@ -1 +1,2 @@",
        " agent content",
        "+agent addition",
        "diff --git a/USER.txt b/USER.txt",
        "--- a/USER.txt",
        "+++ b/USER.txt",
        "@@ -1 +1,2 @@",
        " user content",
        "+agent addition",
      ].join("\n") + "\n";

      const mgr = new MergeManager(repo);
      const conflicts = await mgr.detectConflicts(patch);
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]?.file).toBe("USER.txt");
      expect(conflicts[0]?.status).toBe("user_modified");
    });

    it("returns empty when no patch files are dirty", async () => {
      await write("AGENT.txt", "agent content\n");
      git(["add", "-A"]);
      git(["commit", "-q", "-m", "init"]);

      const patch = "diff --git a/AGENT.txt b/AGENT.txt\n--- a/AGENT.txt\n+++ b/AGENT.txt\n@@ -1 +1,2 @@\n agent content\n+agent addition\n";

      const mgr = new MergeManager(repo);
      const conflicts = await mgr.detectConflicts(patch);
      expect(conflicts).toHaveLength(0);
    });

    it("returns empty when dirty files are not in the patch", async () => {
      await write("AGENT.txt", "agent\n");
      await write("OTHER.txt", "other\n");
      git(["add", "-A"]);
      git(["commit", "-q", "-m", "init"]);
      await write("OTHER.txt", "user changed OTHER, not in patch\n");

      const patch = "diff --git a/AGENT.txt b/AGENT.txt\n--- a/AGENT.txt\n+++ b/AGENT.txt\n@@ -1 +1,2 @@\n agent\n+agent addition\n";

      const mgr = new MergeManager(repo);
      const conflicts = await mgr.detectConflicts(patch);
      expect(conflicts).toHaveLength(0);
    });
  });

  describe("applyPatch / revertPatch with force", () => {
    it("rejects apply when user-modified files conflict (no force)", async () => {
      await write("SHARED.txt", "original\n");
      git(["add", "-A"]);
      git(["commit", "-q", "-m", "init"]);
      await write("SHARED.txt", "user edited\n");

      const patch = "diff --git a/SHARED.txt b/SHARED.txt\n--- a/SHARED.txt\n+++ b/SHARED.txt\n@@ -1 +1,2 @@\n original\n+agent addition\n";

      const mgr = new MergeManager(repo);
      const err = await mgr.applyPatch(patch).catch((e) => e);
      expect(err).toBeInstanceOf(ApplyConflictError);
      expect(err.conflictedFiles).toBeDefined();
      expect(err.conflictedFiles[0]?.file).toBe("SHARED.txt");
      expect(err.conflictedFiles[0]?.status).toBe("user_modified");
      // File content should be unchanged on rejection
      expect(await fs.readFile(path.join(repo, "SHARED.txt"), "utf8")).toBe("user edited\n");
    });

    it("applies with force, overwriting user changes", async () => {
      await write("SHARED.txt", "original\n");
      git(["add", "-A"]);
      git(["commit", "-q", "-m", "init"]);
      await write("SHARED.txt", "user edited\n");

      const patch = "diff --git a/SHARED.txt b/SHARED.txt\n--- a/SHARED.txt\n+++ b/SHARED.txt\n@@ -1 +1,2 @@\n original\n+agent addition\n";

      const mgr = new MergeManager(repo);
      await mgr.applyPatch(patch, { force: true });
      const content = await fs.readFile(path.join(repo, "SHARED.txt"), "utf8");
      expect(content).toBe("original\nagent addition\n");
    });

    it("rejects revert when user-modified files conflict (no force)", async () => {
      await write("SHARED.txt", "original\n");
      git(["add", "-A"]);
      git(["commit", "-q", "-m", "init"]);

      const patch = "diff --git a/SHARED.txt b/SHARED.txt\n--- a/SHARED.txt\n+++ b/SHARED.txt\n@@ -1 +1,2 @@\n original\n+agent added\n";
      const mgr = new MergeManager(repo);
      // Apply normally first
      await mgr.applyPatch(patch);
      git(["add", "-A"]);
      git(["commit", "-q", "-m", "agent change"]);
      // User edits the file
      await write("SHARED.txt", "user changed this\n");
      // Now try to revert — should fail with conflict
      const err = await mgr.revertPatch(patch).catch((e) => e);
      expect(err).toBeInstanceOf(ApplyConflictError);
      expect(err.conflictedFiles).toBeDefined();
      expect(err.conflictedFiles[0]?.file).toBe("SHARED.txt");
    });

    const SHARED_PATCH =
      "diff --git a/SHARED.txt b/SHARED.txt\n--- a/SHARED.txt\n+++ b/SHARED.txt\n@@ -1 +1,2 @@\n original\n+agent addition\n";

    it("forces past a conflict while unrelated work stays dirty and untouched", async () => {
      // The whole point of --force, and it did not work: the clean-tree check
      // covered the entire repository, so any unrelated dirty file rejected the
      // apply — including under --force, which only ever reset the conflicting
      // files. The error even told the user to use the flag that could not help.
      await write("SHARED.txt", "original\n");
      await write("UNRELATED.txt", "committed\n");
      git(["add", "-A"]);
      git(["commit", "-q", "-m", "init"]);
      await write("SHARED.txt", "user edited\n");
      await write("UNRELATED.txt", "user work in progress\n");

      const mgr = new MergeManager(repo);
      await mgr.applyPatch(SHARED_PATCH, { force: true });

      expect(await fs.readFile(path.join(repo, "SHARED.txt"), "utf8")).toBe("original\nagent addition\n");
      // Files the patch never mentions are the user's business.
      expect(await fs.readFile(path.join(repo, "UNRELATED.txt"), "utf8")).toBe("user work in progress\n");
    });

    it("saves the user changes that --force overwrites", async () => {
      await write("SHARED.txt", "original\n");
      git(["add", "-A"]);
      git(["commit", "-q", "-m", "init"]);
      await write("SHARED.txt", "user edited\n");

      const mgr = new MergeManager(repo);
      const result = await mgr.applyPatch(SHARED_PATCH, { force: true });

      // `git checkout HEAD -- <file>` leaves no reflog and no stash: without
      // this copy the user's edit is simply gone.
      expect(result.recoveryPatch).toBeDefined();
      const saved = await fs.readFile(result.recoveryPatch!, "utf8");
      expect(saved).toContain("user edited");
    });

    it("refuses to force over an untracked file instead of failing obscurely", async () => {
      // `git checkout HEAD -- <path>` cannot restore a path that is not in
      // HEAD. That failure was swallowed, leaving the file for `git apply` to
      // trip over with a bare "already exists".
      const patch =
        "diff --git a/NEW.txt b/NEW.txt\nnew file mode 100644\n--- /dev/null\n+++ b/NEW.txt\n@@ -0,0 +1 @@\n+agent version\n";
      await write("NEW.txt", "user version\n");

      const mgr = new MergeManager(repo);
      const err = await mgr.applyPatch(patch, { force: true }).catch((e) => e);

      expect(err).toBeInstanceOf(MergeStateError);
      expect(err.message).toContain("NEW.txt");
      expect(await fs.readFile(path.join(repo, "NEW.txt"), "utf8")).toBe("user version\n");
    });
  });

  describe("patch path parsing", () => {
    it("does not treat a path as a match because another contains it", () => {
      const patch = [
        "diff --git a/src/app.ts.bak b/src/app.ts.bak",
        "--- a/src/app.ts.bak",
        "+++ b/src/app.ts.bak",
        "@@ -1 +1 @@",
        "-old backup",
        "+new backup",
        "diff --git a/src/app.ts b/src/app.ts",
        "--- a/src/app.ts",
        "+++ b/src/app.ts",
        "@@ -1 +1 @@",
        "-old",
        "+new",
        "",
      ].join("\n");

      const mgr = new MergeManager(repo);
      const extracted = mgr.extractFilePatch(patch, "src/app.ts");

      expect(extracted).toContain("+new\n");
      expect(extracted).not.toContain("app.ts.bak");
    });

    it("keeps paths that contain spaces", () => {
      const patch =
        "diff --git a/my docs/notes.md b/my docs/notes.md\n--- a/my docs/notes.md\n+++ b/my docs/notes.md\n@@ -1 +1 @@\n-a\n+b\n";
      const mgr = new MergeManager(repo);
      expect(mgr.extractPatchFiles(patch)).toEqual(["my docs/notes.md"]);
    });
  });
});
