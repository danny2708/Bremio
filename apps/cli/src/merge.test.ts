import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mergeCommand } from "./merge";

let repo: string;
const git = (args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });

beforeEach(async () => {
  repo = await fs.mkdtemp(path.join(os.tmpdir(), "bremio-cli-merge-"));
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@bremio.local"]);
  git(["config", "user.name", "Bremio Test"]);
  await fs.writeFile(path.join(repo, "README.md"), "# base\n");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "init"]);
  git(["checkout", "-q", "-b", "bremio/T1-codex"]);
  await fs.writeFile(path.join(repo, "FEATURE.txt"), "feature\n");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "feature"]);
  git(["checkout", "-q", "main"]);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(repo, { recursive: true, force: true }).catch(() => {});
});

describe("bremio merge quality gate", () => {
  it("refuses to merge a completed task when the run gate failed", async () => {
    const runDir = path.join(repo, ".bremio", "runs", "run-gate-failed");
    await fs.mkdir(runDir, { recursive: true });
    await fs.writeFile(
      path.join(runDir, "report.json"),
      JSON.stringify({
        runId: "run-gate-failed",
        createdAt: new Date().toISOString(),
        prompt: "add feature",
        leadAgentId: "claude",
        repoPath: repo,
        runDir,
        baseBranch: "main",
        plan: {
          summary: "add feature",
          leadAgentId: "claude",
          tasks: [
            {
              id: "T1",
              title: "implement",
              kind: "implementation",
              requiredCapabilities: [],
              preferredAgents: [],
              risk: "low",
              dependencies: [],
              acceptanceCriteria: [],
            },
          ],
        },
        tasks: [
          {
            task: {
              id: "T1",
              title: "implement",
              kind: "implementation",
              requiredCapabilities: [],
              preferredAgents: [],
              risk: "low",
              dependencies: [],
              acceptanceCriteria: [],
            },
            agentId: "codex",
            result: {
              taskId: "T1",
              agentId: "codex",
              status: "completed",
              summary: "done",
              filesChanged: ["FEATURE.txt"],
              commandsExecuted: [],
              tests: [],
              findings: [],
              branch: "bremio/T1-codex",
            },
          },
        ],
        qualityGate: {
          status: "failed",
          testTaskIds: [],
          reviewTaskIds: [],
          reasons: ["T1 has no dependent test task"],
        },
        summary: { total: 1, completed: 1, failed: 0, cancelled: 0, filesChanged: 1 },
      }),
      "utf8",
    );
    vi.spyOn(console, "error").mockImplementation(() => {});

    const code = await mergeCommand({
      repoPath: repo,
      taskId: "T1",
      runId: "run-gate-failed",
      assumeYes: true,
    });

    expect(code).toBe(2);
    await expect(fs.access(path.join(repo, "FEATURE.txt"))).rejects.toThrow();
    expect(git(["branch", "--list", "bremio/T1-codex"]).toString()).toContain(
      "bremio/T1-codex",
    );
  });
});
