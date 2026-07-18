import { execFileSync } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorktreeManager } from "./worktree";

let repo: string;
const git = (args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });

beforeEach(async () => {
  repo = await fs.mkdtemp(path.join(os.tmpdir(), "bremio-worktree-"));
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@bremio.local"]);
  git(["config", "user.name", "Bremio Test"]);
  git(["config", "core.autocrlf", "false"]);
  await fs.writeFile(path.join(repo, "README.md"), "# base\n");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "init"]);
});

afterEach(async () => {
  await fs.rm(repo, { recursive: true, force: true }).catch(() => {});
});

describe("WorktreeManager dependency bases", () => {
  it("integrates every dependency branch without changing the main worktree", async () => {
    const manager = new WorktreeManager(repo, { runToken: "test" });
    const first = await manager.create("T1", "codex");
    await fs.writeFile(path.join(first.path, "FIRST.txt"), "first\n");
    await manager.collect(first);

    const second = await manager.create("T2", "claude");
    await fs.writeFile(path.join(second.path, "SECOND.txt"), "second\n");
    await manager.collect(second);

    const combined = await manager.create("T3", "codex", [first.branch, second.branch]);
    expect(await fs.readFile(path.join(combined.path, "FIRST.txt"), "utf8")).toBe("first\n");
    expect(await fs.readFile(path.join(combined.path, "SECOND.txt"), "utf8")).toBe("second\n");
    expect(existsSync(path.join(repo, "FIRST.txt"))).toBe(false);
    expect(existsSync(path.join(repo, "SECOND.txt"))).toBe(false);

    await manager.remove(combined);
    await manager.remove(first);
    await manager.remove(second);
  });
});
