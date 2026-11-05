import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HookManager, type AgentAdapter, type AgentRunRequest } from "@bremio/adapter-sdk";
import type { AgentEvent } from "@bremio/protocol";
import { createRegistry } from "../registry";
import { extendRegistry } from "./extend-adapter";
import {
  commandHookHandler,
  evaluateRepositoryHook,
  loadHookManager,
  parseHookDefinitions,
} from "./hooks-config";
import { prepareRunExtensions } from "./prepare";

const tmpDirs: string[] = [];
afterEach(async () => {
  for (const d of tmpDirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
});
async function tmpRepo(hooks?: unknown): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bremio-hooks-"));
  tmpDirs.push(dir);
  if (hooks !== undefined) {
    await fs.mkdir(path.join(dir, ".bremio"));
    await fs.writeFile(
      path.join(dir, ".bremio", "hooks.json"),
      typeof hooks === "string" ? hooks : JSON.stringify(hooks),
    );
  }
  return dir;
}

/** A hook implemented as `node -e <script>`, so tests need no shell. */
function nodeHook(id: string, point: string, script: string, extra: Record<string, unknown> = {}) {
  return { id, point, command: process.execPath, args: ["-e", script], ...extra };
}

function fakeAdapter() {
  const calls: AgentRunRequest[] = [];
  const adapter: AgentAdapter = {
    id: "fake",
    provider: "test",
    healthCheck: async () => ({ status: "ok" }),
    getCapabilities: async () => {
      throw new Error("unused");
    },
    getRuntimeCapabilities: async () => ({
      adapterId: "fake",
      transport: "cli",
      approval: "none",
      structuredToolEvents: false,
      contextMetrics: "none",
      manualCompact: false,
      mcp: false,
      webSearch: false,
      cancellation: true,
    }),
    listModels: async () => [],
    async *startRun(req) {
      calls.push(req);
      yield { type: "started", runId: req.runId, ts: 1 };
      yield { type: "completed", runId: req.runId, ts: 2, outcome: { status: "completed", finalText: "ok" } };
    },
    async *resumeRun(_s, req) {
      yield* this.startRun(req);
    },
    cancelRun: async () => {},
  };
  return { adapter, calls };
}

function req(role: AgentRunRequest["role"] = "implementer"): AgentRunRequest {
  return { runId: "r1", role, prompt: "do it", cwd: "/repo", permission: "workspace-write" };
}

async function drain(it: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

function managerWith(point: "run:pre-plan" | "run:pre-task" | "run:post-task", allow: boolean, seen?: unknown[]) {
  return new HookManager().register({
    id: `h-${point}`,
    hookPoint: point,
    handler: async (ctx) => {
      seen?.push(ctx);
      return allow ? { allow: true } : { allow: false, reason: `${point} says no` };
    },
  });
}

describe("hook definitions (P3-T2)", () => {
  it("accepts only run lifecycle points", () => {
    expect(() => parseHookDefinitions([{ id: "x", point: "skill:before-execute", command: "c" }])).toThrow(
      /invalid .*hooks.json at 0.point/,
    );
    expect(parseHookDefinitions([{ id: "x", point: "run:pre-merge", command: "c" }])[0]).toMatchObject({
      args: [],
      timeoutMs: 30_000,
    });
  });

  it("returns no manager when the repository has no hooks file", async () => {
    expect(await loadHookManager(await tmpRepo())).toBeUndefined();
  });
});

describe("command hook handler (P3-T2)", () => {
  const def = (script: string, extra: Record<string, unknown> = {}) =>
    parseHookDefinitions([nodeHook("h", "run:pre-task", script, extra)])[0]!;

  it("allows on exit 0", async () => {
    const repo = await tmpRepo();
    expect(await commandHookHandler(def("process.exit(0)"), repo)({})).toEqual({ allow: true });
  });

  it("vetoes on non-zero exit with the last stderr line as the reason", async () => {
    const repo = await tmpRepo();
    const result = await commandHookHandler(def("console.error('noise');console.error('tests are red');process.exit(2)"), repo)({});
    expect(result).toEqual({ allow: false, reason: "tests are red" });
  });

  it("receives the context as JSON on stdin and the point in the environment", async () => {
    const repo = await tmpRepo();
    const script =
      "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const c=JSON.parse(s);" +
      "if(c.agentId==='codex'&&process.env.BREMIO_HOOK_POINT==='run:pre-task')process.exit(0);" +
      "console.error('bad context '+s);process.exit(1)})";
    expect(await commandHookHandler(def(script), repo)({ agentId: "codex" })).toEqual({ allow: true });
  });

  it("vetoes when the hook times out", async () => {
    const repo = await tmpRepo();
    const result = await commandHookHandler(def("setTimeout(()=>{},10000)", { timeoutMs: 200 }), repo)({});
    expect(result).toEqual({ allow: false, reason: 'hook "h" timed out after 200ms' });
  });

  it("vetoes when the hook cannot start", async () => {
    const repo = await tmpRepo();
    const broken = parseHookDefinitions([{ id: "gone", point: "run:pre-task", command: path.join(repo, "missing-binary") }])[0]!;
    const result = await commandHookHandler(broken, repo)({});
    expect(result.allow).toBe(false);
    expect(result.reason).toMatch(/hook "gone" could not start/);
  });
});

describe("hooks around agent calls (P3-T2)", () => {
  it("a pre-task veto stops the call before the provider is reached", async () => {
    const { adapter, calls } = fakeAdapter();
    const reg = extendRegistry(createRegistry([adapter]), {
      controlMode: "autopilot",
      hooks: managerWith("run:pre-task", false),
    });
    const events = await drain(reg.get("fake")!.startRun(req()));
    expect(calls).toHaveLength(0);
    expect(events.map((e) => e.type)).toEqual(["started", "log", "completed"]);
    const done = events.at(-1) as Extract<AgentEvent, { type: "completed" }>;
    expect(done.outcome).toEqual({ status: "failed", error: 'run:pre-task hook "h-run:pre-task" vetoed: run:pre-task says no' });
  });

  it("a lead call runs pre-plan, not pre-task, and is not post-task checked", async () => {
    const { adapter, calls } = fakeAdapter();
    const seen: unknown[] = [];
    const hooks = managerWith("run:pre-plan", true, seen);
    hooks.register({ id: "never-pre", hookPoint: "run:pre-task", handler: async () => ({ allow: false }) });
    hooks.register({ id: "never-post", hookPoint: "run:post-task", handler: async () => ({ allow: false }) });
    const reg = extendRegistry(createRegistry([adapter]), { controlMode: "autopilot", hooks, repoPath: "/repo" });
    const events = await drain(reg.get("fake")!.startRun(req("lead")));
    expect(calls).toHaveLength(1);
    expect((events.at(-1) as Extract<AgentEvent, { type: "completed" }>).outcome.status).toBe("completed");
    expect(seen[0]).toMatchObject({ hookPoint: "run:pre-plan", agentId: "fake", role: "lead", repoPath: "/repo" });
  });

  it("a post-task veto turns a completed task into a failed one", async () => {
    const { adapter } = fakeAdapter();
    const reg = extendRegistry(createRegistry([adapter]), {
      controlMode: "autopilot",
      hooks: managerWith("run:post-task", false),
    });
    const events = await drain(reg.get("fake")!.startRun(req()));
    const done = events.at(-1) as Extract<AgentEvent, { type: "completed" }>;
    expect(done.outcome.status).toBe("failed");
    expect(done.outcome.error).toMatch(/run:post-task hook .* vetoed: run:post-task says no/);
    expect(done.outcome.finalText).toBe("ok");
  });

  it("prepareRunExtensions loads the repository's hooks into every run", async () => {
    const repo = await tmpRepo([nodeHook("block", "run:pre-task", "console.error('frozen');process.exit(1)")]);
    const { adapter, calls } = fakeAdapter();
    const prepared = await prepareRunExtensions({ repoPath: repo }, createRegistry([adapter]));
    expect(prepared.error).toBeUndefined();
    const events = await drain(prepared.registry.get("fake")!.startRun(req()));
    expect(calls).toHaveLength(0);
    expect((events.at(-1) as Extract<AgentEvent, { type: "completed" }>).outcome.error).toMatch(/vetoed: frozen/);
  });

  it("an invalid hooks file fails the run instead of running unguarded", async () => {
    const repo = await tmpRepo("{not json");
    const { adapter } = fakeAdapter();
    const prepared = await prepareRunExtensions({ repoPath: repo }, createRegistry([adapter]));
    expect(prepared.error).toBeDefined();
  });
});

describe("hooks outside a run (P3-T2)", () => {
  it("allows when no hooks file exists", async () => {
    expect(await evaluateRepositoryHook(await tmpRepo(), "run:pre-merge", {})).toEqual({ allowed: true });
  });

  it("evaluates the named point with repository context", async () => {
    const repo = await tmpRepo([
      nodeHook("no-merge-on-friday", "run:pre-merge", "console.error('not today');process.exit(1)"),
      nodeHook("apply-ok", "run:pre-apply", "process.exit(0)"),
    ]);
    expect(await evaluateRepositoryHook(repo, "run:pre-apply", {})).toEqual({ allowed: true });
    expect(await evaluateRepositoryHook(repo, "run:pre-merge", {})).toEqual({
      allowed: false,
      reason: "not today",
      deniedBy: "no-merge-on-friday",
    });
  });

  it("denies when the hooks file is unreadable", async () => {
    const result = await evaluateRepositoryHook(await tmpRepo("[{]"), "run:pre-apply", {});
    expect(result.allowed).toBe(false);
  });
});
