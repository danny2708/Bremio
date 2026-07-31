import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitOps, GitOpsError } from "./git-ops";

let repo: string;
const git = (args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });

async function write(file: string, content: string): Promise<void> {
  await fs.writeFile(path.join(repo, file), content);
}

beforeEach(async () => {
  repo = await fs.mkdtemp(path.join(os.tmpdir(), "bremio-gitops-"));
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@bremio.local"]);
  git(["config", "user.name", "Bremio Test"]);
  git(["config", "core.autocrlf", "false"]);
  await write("README.md", "base\n");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "init"]);
});

afterEach(async () => {
  await fs.rm(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
});

describe("GitOps.status", () => {
  it("separates staged from unstaged, and names untracked files", async () => {
    await write("README.md", "changed\n");
    await write("new.txt", "brand new\n");
    git(["add", "--", "README.md"]);

    const state = await new GitOps(repo).status();

    expect(state.branch).toBe("main");
    expect(state.detached).toBe(false);
    expect(state.entries).toContainEqual({ path: "README.md", staged: true, status: "modified", untracked: false });
    expect(state.entries).toContainEqual({ path: "new.txt", staged: false, status: "untracked", untracked: true });
  });

  it("reports a file that is staged and modified again as both", async () => {
    // Collapsing these would make the panel offer to commit content the user
    // has already superseded.
    await write("README.md", "staged version\n");
    git(["add", "--", "README.md"]);
    await write("README.md", "newer version\n");

    const state = await new GitOps(repo).status();
    const forFile = state.entries.filter((e) => e.path === "README.md");

    expect(forFile.map((e) => e.staged).sort()).toEqual([false, true]);
  });

  it("says a detached HEAD is detached rather than naming a branch", async () => {
    git(["checkout", "-q", "--detach", "HEAD"]);
    const state = await new GitOps(repo).status();
    expect(state.detached).toBe(true);
    expect(state.branch).toBeUndefined();
  });
});

describe("GitOps.stage", () => {
  it("stages only the paths it was given", async () => {
    // The rule docs/15 §2.4.1 pins: the S5 review removed an add-everything
    // call for flattening a partially staged index, and staging is where it
    // would be most tempting to bring back.
    await write("a.txt", "a\n");
    await write("b.txt", "b\n");

    await new GitOps(repo).stage(["a.txt"]);

    const staged = execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: repo, encoding: "utf8" });
    expect(staged.trim()).toBe("a.txt");
  });

  it("leaves a deliberately unstaged change alone when another file is staged", async () => {
    await write("README.md", "user staged this\n");
    git(["add", "--", "README.md"]);
    await write("other.txt", "not ready yet\n");

    await new GitOps(repo).stage(["other.txt"]);

    const staged = execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: repo, encoding: "utf8" })
      .split("\n").map((s) => s.trim()).filter(Boolean).sort();
    expect(staged).toEqual(["README.md", "other.txt"]);
  });

  it("refuses an empty path list rather than staging everything", async () => {
    await write("a.txt", "a\n");
    await expect(new GitOps(repo).stage([])).rejects.toBeInstanceOf(GitOpsError);

    const staged = execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: repo, encoding: "utf8" });
    expect(staged.trim()).toBe("");
  });

  it("unstages without touching the working tree", async () => {
    await write("a.txt", "a\n");
    await new GitOps(repo).stage(["a.txt"]);
    await new GitOps(repo).unstage(["a.txt"]);

    const staged = execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: repo, encoding: "utf8" });
    expect(staged.trim()).toBe("");
    // The file itself survives — unstaging is not discarding.
    await expect(fs.readFile(path.join(repo, "a.txt"), "utf8")).resolves.toBe("a\n");
  });
});

describe("GitOps branches", () => {
  it("lists local branches and marks the checked-out one", async () => {
    git(["branch", "feature"]);
    const branches = await new GitOps(repo).branches();

    expect(branches.map((b) => b.name).sort()).toEqual(["feature", "main"]);
    expect(branches.find((b) => b.current)?.name).toBe("main");
  });

  it("creates a branch and switches to it", async () => {
    await new GitOps(repo).createBranch("feature/new");
    expect((await new GitOps(repo).status()).branch).toBe("feature/new");
  });

  it("refuses to create a branch that already exists", async () => {
    // "Create" and "move to the one already there" are different intentions;
    // the second would quietly adopt someone else's history.
    git(["branch", "taken"]);
    await expect(new GitOps(repo).createBranch("taken")).rejects.toThrow(/already exists/);
  });

  it("switches when the tree is clean", async () => {
    git(["branch", "other"]);
    await new GitOps(repo).switchBranch("other");
    expect((await new GitOps(repo).status()).branch).toBe("other");
  });

  it("refuses to switch with uncommitted changes, and names them", async () => {
    // Git would carry the changes across for many switches. That is the
    // behaviour to avoid, not inherit: work started against one branch
    // silently becomes work against another.
    git(["branch", "other"]);
    await write("README.md", "work in progress\n");

    const error = await new GitOps(repo).switchBranch("other").catch((e: Error) => e);

    expect(error).toBeInstanceOf(GitOpsError);
    expect((error as Error).message).toContain("README.md");
    expect((error as Error).message).toMatch(/commit or stash/i);
    // And it really did not move.
    expect((await new GitOps(repo).status()).branch).toBe("main");
  });

  it("allows a switch when the only changes are untracked", async () => {
    // An untracked file is not attached to any branch, so carrying it across
    // loses nothing and blocking on it would be needless.
    git(["branch", "other"]);
    await write("scratch.txt", "not tracked\n");

    await new GitOps(repo).switchBranch("other");

    expect((await new GitOps(repo).status()).branch).toBe("other");
  });

  it("refuses a blank branch name", async () => {
    await expect(new GitOps(repo).switchBranch("  ")).rejects.toThrow(/name is required/);
    await expect(new GitOps(repo).createBranch("")).rejects.toThrow(/name is required/);
  });
});

describe("GitOps.commit", () => {
  it("commits what is staged and reports the hash", async () => {
    await write("a.txt", "a\n");
    await new GitOps(repo).stage(["a.txt"]);

    const result = await new GitOps(repo).commit("add a");

    expect(result.hash).toMatch(/^[0-9a-f]{7,40}$/);
    const log = execFileSync("git", ["log", "-1", "--format=%s"], { cwd: repo, encoding: "utf8" });
    expect(log.trim()).toBe("add a");
  });

  it("commits only the staged version, not later edits", async () => {
    await write("a.txt", "first\n");
    await new GitOps(repo).stage(["a.txt"]);
    await write("a.txt", "second\n");

    await new GitOps(repo).commit("only the first");

    const committed = execFileSync("git", ["show", "HEAD:a.txt"], { cwd: repo, encoding: "utf8" });
    expect(committed).toBe("first\n");
  });

  it("refuses an empty index rather than writing an empty commit", async () => {
    // A commit that records nothing is a lie in the history.
    await expect(new GitOps(repo).commit("nothing")).rejects.toThrow(/nothing is staged/);
  });

  it("refuses a blank message", async () => {
    await write("a.txt", "a\n");
    await new GitOps(repo).stage(["a.txt"]);
    await expect(new GitOps(repo).commit("   ")).rejects.toThrow(/message is required/);
  });
});
