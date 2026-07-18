import { execFileSync } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MergeConflictError, MergeManager, MergeStateError } from "./merge";

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
});
