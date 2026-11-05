import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AdapterRuntimeCapabilities, AgentAdapter, AgentRunRequest } from "@bremio/adapter-sdk";
import type { AgentEvent } from "@bremio/protocol";
import type { RunReport } from "./aggregator";
import { autoPrPolicyBlock } from "./auto-pr";
import { createRegistry } from "./registry";
import { runBremio } from "./run";
import { runSingleAgent } from "./single-run";

abstract class Base implements AgentAdapter {
  abstract readonly id: string;
  readonly provider = "test";
  async getCapabilities() {
    return {
      planning: true, structuredOutput: true, repositoryRead: true, repositoryWrite: true,
      shell: true, testing: true, browser: false, vision: false, resumableSessions: false,
      readOnlyEnforcement: "provider-native" as const,
    };
  }
  async listModels() { return []; }
  async healthCheck() { return { status: "ok" as const }; }
  resumeRun(): AsyncIterable<AgentEvent> { throw new Error("no resume"); }
  async cancelRun() {}
  async getRuntimeCapabilities(): Promise<AdapterRuntimeCapabilities> {
    return {
      adapterId: this.id, transport: "cli", approval: "none", structuredToolEvents: true,
      contextMetrics: "none", manualCompact: false, mcp: false, webSearch: false, cancellation: true,
    };
  }
  abstract startRun(req: AgentRunRequest): AsyncIterable<AgentEvent>;
}

class Lead extends Base {
  readonly id = "claude";
  async *startRun(req: AgentRunRequest): AsyncIterable<AgentEvent> {
    const ts = Date.now();
    if (req.prompt.includes("PLAN RULES")) {
      const plan = {
        summary: "Add FEATURE",
        leadAgentId: "claude",
        tasks: [
          { id: "IMPL", title: "Write FEATURE", kind: "implementation", risk: "low", requiredCapabilities: ["repository.write"] },
          { id: "TEST", title: "Check", kind: "test", risk: "low", dependencies: ["IMPL"], requiredCapabilities: ["shell", "test"] },
          { id: "REVIEW", title: "Review", kind: "review", risk: "low", dependencies: ["IMPL"], requiredCapabilities: ["repository.read", "review"] },
        ],
      };
      yield { type: "completed", runId: req.runId, ts, outcome: { status: "completed", finalText: JSON.stringify(plan) } };
      return;
    }
    const review = { summary: "ok", findings: [] };
    yield { type: "completed", runId: req.runId, ts, outcome: { status: "completed", structured: review } };
  }
}

class Worker extends Base {
  readonly id = "codex";
  constructor(private readonly testExit = 0) { super(); }
  async *startRun(req: AgentRunRequest): AsyncIterable<AgentEvent> {
    const ts = Date.now();
    if (req.role === "tester") {
      yield { type: "tool_use", runId: req.runId, ts, name: "shell", input: { command: "check" } };
      yield { type: "tool_result", runId: req.runId, ts, name: "shell", ok: this.testExit === 0, exitCode: this.testExit };
    } else {
      await fs.writeFile(path.join(req.cwd, "FEATURE"), "feature\n");
    }
    yield { type: "completed", runId: req.runId, ts, outcome: { status: "completed" } };
  }
}

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
});

/** A repo whose origin *looks* like GitHub but pushes to a local bare repo. */
async function repoWithRemote(): Promise<{ repo: string; bare: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bremio-autopr-"));
  dirs.push(root);
  const repo = path.join(root, "repo");
  const bare = path.join(root, "origin.git");
  await fs.mkdir(repo);
  execFileSync("git", ["init", "-q", "--bare", bare]);
  const git = (args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "test@bremio.local"]);
  git(["config", "user.name", "Bremio Test"]);
  await fs.writeFile(path.join(repo, "README.md"), "# auto pr\n");
  git(["add", "README.md"]);
  git(["commit", "-q", "-m", "init"]);
  git(["remote", "add", "origin", "https://github.com/acme/widget.git"]);
  git(["config", "remote.origin.pushurl", bare]);
  return { repo, bare };
}

function fakeGh(opts: { installed?: boolean } = {}) {
  const calls: string[][] = [];
  const runner = async (args: string[]) => {
    calls.push(args);
    if (opts.installed === false) {
      const err = new Error("spawn gh ENOENT") as Error & { code?: string };
      err.code = "ENOENT";
      throw err;
    }
    if (args[0] === "auth") return { stdout: "Logged in", stderr: "" };
    return { stdout: "https://github.com/acme/widget/pull/7\n", stderr: "" };
  };
  return { calls, runner };
}

describe("P2-T7 auto-PR on green", () => {
  it("Team: merges the implementation onto bremio/pr-<runId>, pushes it and opens a PR", async () => {
    const { repo, bare } = await repoWithRemote();
    const gh = fakeGh();
    const report = await runBremio({
      leadId: "claude",
      repoPath: repo,
      prompt: "add a feature",
      registry: createRegistry([new Lead(), new Worker()]),
      autoPr: true,
      autoPrDeps: { ghRunner: gh.runner },
    }) as RunReport;

    expect(report.qualityGate.status).toBe("passed");
    expect(report.autoPr).toEqual({
      status: "opened",
      url: "https://github.com/acme/widget/pull/7",
      branch: `bremio/pr-${report.runId}`,
    });
    const prCall = gh.calls.find((c) => c[0] === "pr")!;
    expect(prCall).toEqual(expect.arrayContaining(["--base", "main", "--head", `bremio/pr-${report.runId}`]));
    expect(prCall[prCall.indexOf("--body") + 1]).toMatch(/Definition of done/);
    // the pushed branch carries the implementation
    const pushed = execFileSync("git", ["--git-dir", bare, "show", `bremio/pr-${report.runId}:FEATURE`], { encoding: "utf8" });
    expect(pushed.trim()).toBe("feature");
    // the user's checkout is untouched
    expect(execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repo, encoding: "utf8" }).trim()).toBe("main");
    await expect(fs.stat(path.join(repo, "FEATURE"))).rejects.toThrow();
  });

  it("refuses on a red gate without pushing or calling gh", async () => {
    const { repo, bare } = await repoWithRemote();
    const gh = fakeGh();
    const report = await runBremio({
      leadId: "claude",
      repoPath: repo,
      prompt: "add a feature",
      registry: createRegistry([new Lead(), new Worker(1)]),
      autoPr: true,
      autoPrDeps: { ghRunner: gh.runner },
    }) as RunReport;
    expect(report.autoPr?.status).toBe("refused");
    expect(report.autoPr?.reason).toMatch(/quality gate is failed/);
    expect(gh.calls).toHaveLength(0);
    expect(execFileSync("git", ["--git-dir", bare, "branch"], { encoding: "utf8" }).trim()).toBe("");
  });

  it("names the remedy when gh is not installed", async () => {
    const { repo } = await repoWithRemote();
    const report = await runBremio({
      leadId: "claude",
      repoPath: repo,
      prompt: "add a feature",
      registry: createRegistry([new Lead(), new Worker()]),
      autoPr: true,
      autoPrDeps: { ghRunner: fakeGh({ installed: false }).runner },
    }) as RunReport;
    expect(report.autoPr?.status).toBe("failed");
    expect(report.autoPr?.reason).toMatch(/GitHub CLI \(`gh`\) is not installed/);
  });

  it("Single: refuses direct-workspace changes and never runs without --auto-pr", async () => {
    const { repo } = await repoWithRemote();
    const report = await runSingleAgent({
      primaryAgentId: "codex",
      repoPath: repo,
      prompt: "add a feature",
      registry: createRegistry([new Worker()]),
      verifyCommand: "node -e \"process.exit(0)\"",
      autoPr: true,
      autoPrDeps: { ghRunner: fakeGh().runner },
    });
    expect(report.verification.status).toBe("passed");
    expect(report.autoPr?.status).toBe("refused");
    expect(report.autoPr?.reason).toMatch(/isolated worktree/);

    const plain = await runSingleAgent({
      primaryAgentId: "codex",
      repoPath: repo,
      prompt: "again",
      registry: createRegistry([new Worker()]),
    });
    expect(plain.autoPr).toBeUndefined();
  });

  it("Single: pushes the isolated worktree branch on green", async () => {
    const { repo, bare } = await repoWithRemote();
    const gh = fakeGh();
    const report = await runSingleAgent({
      primaryAgentId: "codex",
      repoPath: repo,
      prompt: "add a feature",
      registry: createRegistry([new Worker()]),
      workspaceStrategy: "isolated-worktree",
      verifyCommand: "node -e \"process.exit(0)\"",
      autoPr: true,
      autoPrDeps: { ghRunner: gh.runner },
    });
    expect(report.autoPr?.status).toBe("opened");
    const branch = report.worktree!.branch;
    expect(execFileSync("git", ["--git-dir", bare, "show", `${branch}:FEATURE`], { encoding: "utf8" }).trim()).toBe("feature");
  });

  it("policy: never under plan mode; approve mode needs a person", () => {
    expect(autoPrPolicyBlock("plan")).toMatch(/plan mode/);
    expect(autoPrPolicyBlock("approve")).toMatch(/cannot run unattended/);
    expect(autoPrPolicyBlock("autopilot")).toBeUndefined();
  });
});
