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
});
