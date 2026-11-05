import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  AgentAdapter,
  AgentRunRequest,
  AdapterRuntimeCapabilities,
  McpServerManifest,
} from "@bremio/adapter-sdk";
import type { AgentEvent } from "@bremio/protocol";
import { createRegistry } from "../registry";
import { trustConfig } from "./trust";
import { extendRegistry } from "./extend-adapter";
import {
  assertMcpRequestUsable,
  bremioMcpManifest,
  loadMcpManifests,
  mcpPolicyGate,
  parseMcpManifests,
  selectMcpServers,
} from "./mcp-config";
import { prepareRunExtensions } from "./prepare";

// Never touch the real ~/.bremio trust store from tests.
process.env.BREMIO_TRUST_FILE = path.join(
  os.tmpdir(),
  `bremio-trust-test-${process.pid}-${Math.random().toString(36).slice(2)}.json`,
);


const DOCS: McpServerManifest = {
  id: "docs",
  name: "Docs",
  transport: { type: "stdio", command: "docs-mcp", args: [] },
};

function fakeAdapter(id: string, caps: Partial<AdapterRuntimeCapabilities>) {
  const seen: AgentRunRequest[] = [];
  const adapter: AgentAdapter = {
    id,
    provider: "test",
    healthCheck: async () => ({ status: "ok" }),
    getCapabilities: async () => {
      throw new Error("unused");
    },
    getRuntimeCapabilities: async () => ({
      adapterId: id,
      transport: "cli",
      approval: "none",
      structuredToolEvents: false,
      contextMetrics: "none",
      manualCompact: false,
      mcp: false,
      webSearch: false,
      cancellation: true,
      ...caps,
    }),
    listModels: async () => [],
    async *startRun(req) {
      seen.push(req);
      yield { type: "started", runId: req.runId, ts: 1 };
      yield { type: "completed", runId: req.runId, ts: 2, outcome: { status: "completed" } };
    },
    async *resumeRun(_sessionId, req) {
      seen.push(req);
      yield { type: "started", runId: req.runId, ts: 1 };
      yield { type: "completed", runId: req.runId, ts: 2, outcome: { status: "completed" } };
    },
    cancelRun: async () => {},
  };
  return { adapter, seen };
}

const req = (): AgentRunRequest => ({
  runId: "r1",
  role: "implementer",
  prompt: "p",
  cwd: "/repo",
  permission: "workspace-write",
});

async function drain(it: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

const tmpDirs: string[] = [];
afterEach(async () => {
  for (const d of tmpDirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
});
async function repoWithManifest(content: unknown): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bremio-mcp-"));
  tmpDirs.push(dir);
  await fs.mkdir(path.join(dir, ".bremio"));
  await fs.writeFile(path.join(dir, ".bremio", "mcp-servers.json"), JSON.stringify(content));
  await trustConfig(dir, path.join(".bremio", "mcp-servers.json"));
  return dir;
}

describe("MCP manifest (P3-T1)", () => {
  it("rejects ids that could address provider config paths", () => {
    expect(() => parseMcpManifests([{ ...DOCS, id: "a.b" }])).toThrow(/id must be/);
  });

  it("rejects duplicate ids", () => {
    expect(() => parseMcpManifests([DOCS, DOCS])).toThrow(/duplicate server id "docs"/);
  });

  it("treats a missing manifest file as no servers", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bremio-mcp-"));
    tmpDirs.push(dir);
    expect(await loadMcpManifests(dir)).toEqual([]);
  });

  it("selects nothing unless servers are requested by id", () => {
    expect(selectMcpServers([DOCS], undefined)).toEqual([]);
    expect(selectMcpServers([DOCS], [])).toEqual([]);
    expect(selectMcpServers([DOCS], ["docs"])).toEqual([DOCS]);
  });

  it("errors on an unknown requested id instead of skipping it", () => {
    expect(() => selectMcpServers([DOCS], ["web"])).toThrow(/"web" is not declared .*declared: docs/);
  });

  it("refuses MCP servers in plan and approve modes", () => {
    expect(() => assertMcpRequestUsable("plan", [DOCS])).toThrow(/plan mode prohibits MCP tool use/);
    expect(() => assertMcpRequestUsable("approve", [DOCS])).toThrow(/per-action approval/);
    expect(() => assertMcpRequestUsable("autopilot", [DOCS])).not.toThrow();
    expect(() => assertMcpRequestUsable("plan", [])).not.toThrow();
  });

  it("gates per the policy matrix", () => {
    expect(mcpPolicyGate("plan")("x").allowed).toBe(false);
    expect(mcpPolicyGate("approve")("x").approvalRequired).toBe("per-action");
    expect(mcpPolicyGate("autopilot")("x")).toMatchObject({ allowed: true, approvalRequired: "none" });
  });
});

describe("extendRegistry (P3-T1)", () => {
  it("adds the run's MCP gate to every request even without servers", async () => {
    const { adapter, seen } = fakeAdapter("a", {});
    const reg = extendRegistry(createRegistry([adapter]), { controlMode: "plan" });
    await drain(reg.get("a")!.startRun(req()));
    expect(seen[0]!.mcpServers).toBeUndefined();
    expect(seen[0]!.mcpToolGate!("mcp__x__y").allowed).toBe(false);
  });

  it("passes opted-in servers on start and on resume", async () => {
    const { adapter, seen } = fakeAdapter("a", { mcp: true, mcpTransports: ["stdio"] });
    const reg = extendRegistry(createRegistry([adapter]), { controlMode: "autopilot", mcpServers: [DOCS] });
    const events = await drain(reg.get("a")!.startRun(req()));
    await drain(reg.get("a")!.resumeRun("s", req()));
    expect(seen.map((r) => r.mcpServers)).toEqual([[DOCS], [DOCS]]);
    expect(events.map((e) => e.type)).toEqual(["started", "completed"]);
  });

  it("names an adapter that cannot carry the requested servers, after `started`", async () => {
    const { adapter } = fakeAdapter("agy", { mcp: false });
    const reg = extendRegistry(createRegistry([adapter]), { controlMode: "autopilot", mcpServers: [DOCS] });
    const events = await drain(reg.get("agy")!.startRun(req()));
    expect(events[0]!.type).toBe("started");
    expect(events[1]).toMatchObject({ type: "log", level: "warn" });
    expect((events[1] as { message: string }).message).toMatch(/agy cannot attach MCP servers/);
  });

  it("names a server whose transport the adapter cannot carry", async () => {
    const { adapter } = fakeAdapter("codex", { mcp: true, mcpTransports: ["stdio", "streamable-http"] });
    const sse: McpServerManifest = { id: "s", name: "s", transport: { type: "sse", url: "https://x.test" } };
    const reg = extendRegistry(createRegistry([adapter]), { controlMode: "autopilot", mcpServers: [sse] });
    const events = await drain(reg.get("codex")!.startRun(req()));
    expect(events.some((e) => e.type === "log" && /uses sse, which codex cannot attach/.test(e.message))).toBe(true);
  });
});

describe("prepareRunExtensions (P3-T1)", () => {
  it("resolves requested servers from the repository manifest", async () => {
    const repo = await repoWithManifest([DOCS]);
    const { adapter, seen } = fakeAdapter("a", { mcp: true, mcpTransports: ["stdio"] });
    const prepared = await prepareRunExtensions({ repoPath: repo, mcpServers: ["docs"] }, createRegistry([adapter]));
    expect(prepared.error).toBeUndefined();
    await drain(prepared.registry.get("a")!.startRun(req()));
    expect(seen[0]!.mcpServers).toEqual([DOCS]);
  });

  it("attaches the built-in bremio server with the run's mode and id, without a manifest entry", async () => {
    const repo = await repoWithManifest([]);
    const { adapter, seen } = fakeAdapter("a", { mcp: true, mcpTransports: ["stdio"] });
    const prepared = await prepareRunExtensions(
      {
        repoPath: repo,
        mcpServers: ["bremio"],
        runId: "run-7",
        bremioServerLaunch: { command: "/usr/bin/node", args: ["/opt/bremio.js", "mcp", "serve"] },
      },
      createRegistry([adapter]),
    );
    expect(prepared.error).toBeUndefined();
    await drain(prepared.registry.get("a")!.startRun(req()));
    expect(seen[0]!.mcpServers).toEqual([
      expect.objectContaining({
        id: "bremio",
        transport: expect.objectContaining({
          type: "stdio",
          command: "/usr/bin/node",
          args: ["/opt/bremio.js", "mcp", "serve"],
          env: { BREMIO_CONTROL_MODE: "autopilot", BREMIO_RUN_ID: "run-7" },
        }),
      }),
    ]);
  });

  it("passes web-search configuration to the bremio server by name, never by value", () => {
    const manifest = bremioMcpManifest({
      controlMode: "autopilot",
      launch: { command: "node", args: [] },
      env: { BREMIO_WEB_SEARCH_API_KEY_ENV: "MY_KEY", MY_KEY: "secret-value" },
    });
    const t = manifest.transport as unknown as { env: Record<string, string>; envPassthrough: string[] };
    expect(t.envPassthrough).toContain("MY_KEY");
    expect(t.envPassthrough).toContain("BREMIO_WEB_SEARCH_BACKEND");
    expect(JSON.stringify(manifest)).not.toContain("secret-value");
  });

  it("does not let a manifest claim the reserved bremio id", () => {
    expect(() => parseMcpManifests([{ ...DOCS, id: "bremio" }])).toThrow(/reserved/);
  });

  it("returns a named error, and still a gated registry, when the request is unusable", async () => {
    const repo = await repoWithManifest([DOCS]);
    const { adapter, seen } = fakeAdapter("a", {});
    const prepared = await prepareRunExtensions(
      { repoPath: repo, controlMode: "plan", mcpServers: ["docs"] },
      createRegistry([adapter]),
    );
    expect(prepared.error?.message).toMatch(/plan mode prohibits MCP tool use/);
    await drain(prepared.registry.get("a")!.startRun(req()));
    expect(seen[0]!.mcpServers).toBeUndefined();
    expect(seen[0]!.mcpToolGate!("t").allowed).toBe(false);
  });
});
