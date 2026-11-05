import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  AdapterRuntimeCapabilities,
  AgentAdapter,
  AgentCapabilities,
  AgentRunRequest,
} from "@bremio/adapter-sdk";
import type { AgentEvent } from "@bremio/protocol";
import { createRegistry } from "./registry";
import { runSingleAgent } from "./single-run";
import { verificationPolicyBlock } from "./single-fix-loop";

function caps(resumable: boolean): AgentCapabilities {
  return {
    planning: true, structuredOutput: true, repositoryRead: true, repositoryWrite: true,
    shell: true, testing: true, browser: false, vision: false, resumableSessions: resumable,
    readOnlyEnforcement: "provider-native",
  };
}

/**
 * Writes VALUE=bad on the first turn and VALUE=good once it receives
 * failure evidence (if `fixes`). Records which entry point each turn used.
 */
class Agent implements AgentAdapter {
  readonly id = "codex";
  readonly provider = "test";
  readonly turns: Array<{ via: "start" | "resume"; prompt: string; sessionId?: string }> = [];
  constructor(private readonly opts: { fixes: boolean; resumable: boolean }) {}
  async getCapabilities() { return caps(this.opts.resumable); }
  async listModels() { return []; }
  async healthCheck() { return { status: "ok" as const }; }
  async cancelRun() {}
  async getRuntimeCapabilities(): Promise<AdapterRuntimeCapabilities> {
    return {
      adapterId: this.id, transport: "cli", approval: "none", structuredToolEvents: true,
      contextMetrics: "none", manualCompact: false, mcp: false, webSearch: false, cancellation: true,
    };
  }
  startRun(req: AgentRunRequest): AsyncIterable<AgentEvent> {
    this.turns.push({ via: "start", prompt: req.prompt });
    return this.#turn(req);
  }
  resumeRun(sessionId: string, req: AgentRunRequest): AsyncIterable<AgentEvent> {
    this.turns.push({ via: "resume", prompt: req.prompt, sessionId });
    return this.#turn(req);
  }
  async *#turn(req: AgentRunRequest): AsyncIterable<AgentEvent> {
    const ts = Date.now();
    const good = req.prompt.includes("FAILURE EVIDENCE") && this.opts.fixes;
    await fs.writeFile(path.join(req.cwd, "VALUE"), good ? "good\n" : "bad\n");
    yield { type: "tool_use", runId: req.runId, ts, name: "Write", input: { file_path: "VALUE" } };
    yield { type: "usage", runId: req.runId, ts, inputTokens: 5, outputTokens: 1, costUsd: 0.01 };
    yield {
      type: "completed", runId: req.runId, ts,
      outcome: { status: "completed", finalText: `wrote ${good ? "good" : "bad"}`, sessionId: "sess-1" },
    };
  }
}

const repos: string[] = [];
afterEach(async () => {
  for (const repo of repos.splice(0)) await fs.rm(repo, { recursive: true, force: true }).catch(() => {});
});

async function freshRepo(): Promise<string> {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "bremio-sfix-"));
  repos.push(repo);
  const git = (args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "test@bremio.local"]);
  git(["config", "user.name", "Bremio Test"]);
  await fs.writeFile(path.join(repo, "README.md"), "# single fix\n");
  git(["add", "README.md"]);
  git(["commit", "-q", "-m", "init"]);
  return repo;
}

// Portable verification command: exits 0 only when VALUE says good.
const VERIFY = `node -e "process.exit(require('fs').readFileSync('VALUE','utf8').trim()==='good'?0:1)"`;

describe("P2-T4 Single verify → fix loop", () => {
  it("resumes the provider session with failure evidence and passes", async () => {
    const repo = await freshRepo();
    const agent = new Agent({ fixes: true, resumable: true });
    const report = await runSingleAgent({
      primaryAgentId: "codex",
      repoPath: repo,
      prompt: "set VALUE",
      registry: createRegistry([agent]),
      verifyCommand: VERIFY,
      maxFixIterations: 2,
    });
    expect(report.fixLoop?.status).toBe("passed");
    expect(report.fixLoop?.verifications.map((v) => v.exitCode)).toEqual([1, 0]);
    expect(report.fixLoop?.attempts).toEqual([
      expect.objectContaining({ iteration: 1, mechanism: "resume", turnStatus: "completed", costUsd: 0.01 }),
    ]);
    expect(agent.turns.map((t) => t.via)).toEqual(["start", "resume"]);
    expect(agent.turns[1]?.sessionId).toBe("sess-1");
    expect(agent.turns[1]?.prompt).toMatch(/exit code: 1/);
    expect(report.verification.status).toBe("passed");
    expect(report.result.tests.map((t) => t.exitCode)).toEqual([1, 0]);
    expect(report.result.usage).toEqual({ inputTokens: 10, outputTokens: 2, costUsd: 0.02 });
    expect((await fs.readFile(path.join(repo, "VALUE"), "utf8")).trim()).toBe("good");
  });

  it("falls back to a fresh turn carrying the original request when resume is unsupported", async () => {
    const repo = await freshRepo();
    const agent = new Agent({ fixes: true, resumable: false });
    const report = await runSingleAgent({
      primaryAgentId: "codex",
      repoPath: repo,
      prompt: "set VALUE",
      registry: createRegistry([agent]),
      verifyCommand: VERIFY,
      maxFixIterations: 1,
    });
    expect(report.fixLoop?.status).toBe("passed");
    expect(agent.turns.map((t) => t.via)).toEqual(["start", "start"]);
    expect(agent.turns[1]?.prompt).toMatch(/set VALUE/);
    expect(agent.turns[1]?.prompt).toMatch(/wrote bad/);
  });

  it("stops with a named reason after maxFixIterations and fails verification", async () => {
    const repo = await freshRepo();
    const report = await runSingleAgent({
      primaryAgentId: "codex",
      repoPath: repo,
      prompt: "set VALUE",
      registry: createRegistry([new Agent({ fixes: false, resumable: true })]),
      verifyCommand: VERIFY,
      maxFixIterations: 2,
    });
    expect(report.fixLoop?.status).toBe("exhausted");
    expect(report.fixLoop?.reason).toMatch(/maxFixIterations \(2\)/);
    expect(report.fixLoop?.attempts).toHaveLength(2);
    expect(report.verification.status).toBe("failed");
  });

  it("maxFixIterations 0 verifies once and never re-prompts", async () => {
    const repo = await freshRepo();
    const agent = new Agent({ fixes: true, resumable: true });
    const report = await runSingleAgent({
      primaryAgentId: "codex",
      repoPath: repo,
      prompt: "set VALUE",
      registry: createRegistry([agent]),
      verifyCommand: VERIFY,
    });
    expect(report.fixLoop?.status).toBe("disabled");
    expect(agent.turns).toHaveLength(1);
    expect(report.verification.status).toBe("failed");
  });

  it("without --verify the run is unchanged", async () => {
    const repo = await freshRepo();
    const report = await runSingleAgent({
      primaryAgentId: "codex",
      repoPath: repo,
      prompt: "set VALUE",
      registry: createRegistry([new Agent({ fixes: true, resumable: true })]),
      maxFixIterations: 2,
    });
    expect(report.fixLoop).toBeUndefined();
    expect(report.verification.status).toBe("unverified");
  });

  it("policy: Bremio runs no command in plan or approve mode", () => {
    expect(verificationPolicyBlock("plan")).toMatch(/plan mode/);
    expect(verificationPolicyBlock("approve")).toMatch(/per-action approval/);
    expect(verificationPolicyBlock("autopilot")).toBeUndefined();
  });
});
