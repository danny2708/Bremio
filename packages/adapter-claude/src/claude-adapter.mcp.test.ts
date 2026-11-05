import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRunRequest, McpPermissionCheck, McpServerManifest } from "@bremio/adapter-sdk";
import type { AgentEvent } from "@bremio/protocol";

// The fake SDK records the options it was called with and, like the real CLI,
// asks `canUseTool` before running each tool the "model" requests.
const calls: Array<{ options: Record<string, unknown> }> = [];
let toolsToRequest: string[] = [];
const decisions: Array<{ tool: string; behavior: string }> = [];

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn().mockImplementation(async function* ({ options }: { options: Record<string, unknown> }) {
    calls.push({ options });
    const canUseTool = options.canUseTool as (
      name: string,
      input: Record<string, unknown>,
      o: { signal: AbortSignal },
    ) => Promise<{ behavior: string }>;
    for (const tool of toolsToRequest) {
      const decision = await canUseTool(tool, {}, { signal: new AbortController().signal });
      decisions.push({ tool, behavior: decision.behavior });
      yield { type: "assistant", message: { content: [{ type: "text", text: `asked ${tool}` }] } };
    }
    yield { type: "result", subtype: "success", result: "done", session_id: "s-1" };
  }),
}));

const { ClaudeAdapter, toClaudeMcpServers } = await import("./claude-adapter");

const DOCS: McpServerManifest = {
  id: "docs",
  name: "Docs",
  transport: { type: "stdio", command: "docs-mcp", args: ["--port", "0"], env: { TOKEN: "x" } },
};
const REMOTE: McpServerManifest = {
  id: "remote",
  name: "Remote",
  transport: { type: "streamable-http", url: "https://mcp.example.test/mcp" },
};

const allow = (): McpPermissionCheck => ({ allowed: true, approvalRequired: "none", reason: "autopilot" });
const planDeny = (): McpPermissionCheck => ({
  allowed: false,
  approvalRequired: "none",
  reason: "plan mode prohibits MCP tool use",
});

function request(overrides: Partial<AgentRunRequest> = {}): AgentRunRequest {
  return {
    runId: "run-mcp-1",
    role: "implementer",
    prompt: "do it",
    cwd: "/tmp/repo",
    permission: "workspace-write",
    ...overrides,
  };
}

async function drain(req: AgentRunRequest): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const e of new ClaudeAdapter().startRun(req)) events.push(e);
  return events;
}

beforeEach(() => {
  calls.length = 0;
  decisions.length = 0;
  toolsToRequest = [];
});

describe("Claude MCP pass-through (P3-T1)", () => {
  it("passes opted-in manifest servers to the SDK as mcpServers", async () => {
    await drain(request({ mcpServers: [DOCS, REMOTE], mcpToolGate: allow }));
    expect(calls[0]!.options.mcpServers).toEqual({
      docs: { type: "stdio", command: "docs-mcp", args: ["--port", "0"], env: { TOKEN: "x" } },
      remote: { type: "http", url: "https://mcp.example.test/mcp" },
    });
  });

  it("attaches nothing when no server was opted in", async () => {
    await drain(request({ mcpToolGate: allow }));
    expect(calls[0]!.options).not.toHaveProperty("mcpServers");
  });

  it("never attaches servers to a read-only request", async () => {
    await drain(request({ permission: "read-only", mcpServers: [DOCS], mcpToolGate: allow }));
    expect(calls[0]!.options).not.toHaveProperty("mcpServers");
  });

  it("allows an MCP call the run policy permits", async () => {
    toolsToRequest = ["mcp__docs__search"];
    await drain(request({ mcpServers: [DOCS], mcpToolGate: allow }));
    expect(decisions).toEqual([{ tool: "mcp__docs__search", behavior: "allow" }]);
  });

  it("denies an MCP call the policy forbids and surfaces the denial as an event", async () => {
    toolsToRequest = ["mcp__docs__search"];
    const events = await drain(request({ mcpServers: [DOCS], mcpToolGate: planDeny }));
    expect(decisions).toEqual([{ tool: "mcp__docs__search", behavior: "deny" }]);
    const denial = events.find((e) => e.type === "log" && /denied/.test(e.message ?? ""));
    expect(denial).toMatchObject({ level: "warn" });
    expect(denial && "message" in denial ? denial.message : "").toContain("plan mode prohibits MCP tool use");
  });

  it("denies an MCP call that needs approval which was never granted", async () => {
    toolsToRequest = ["mcp__docs__search"];
    const events = await drain(
      request({
        mcpServers: [DOCS],
        mcpToolGate: () => ({ allowed: true, approvalRequired: "per-action", reason: "approve mode" }),
      }),
    );
    expect(decisions[0]!.behavior).toBe("deny");
    expect(events.some((e) => e.type === "log" && /per-action approval/.test(e.message ?? ""))).toBe(true);
  });

  it("fails closed when a run supplies no MCP gate at all", async () => {
    toolsToRequest = ["mcp__users_own_server__write"];
    await drain(request());
    expect(decisions[0]!.behavior).toBe("deny");
  });

  it("does not gate non-MCP tools through the MCP policy", async () => {
    toolsToRequest = ["Bash"];
    await drain(request({ mcpToolGate: planDeny }));
    expect(decisions[0]!.behavior).toBe("allow");
  });

  it("reports MCP support with the transports it can carry", async () => {
    const caps = await new ClaudeAdapter().getRuntimeCapabilities();
    expect(caps.mcp).toBe(true);
    expect(caps.mcpTransports).toEqual(["stdio", "sse", "streamable-http"]);
  });

  it("skips a stdio server with a custom cwd, naming the reason", () => {
    const { servers, skipped } = toClaudeMcpServers([
      { ...DOCS, transport: { type: "stdio", command: "x", args: [], cwd: "/elsewhere" } },
    ]);
    expect(servers).toEqual({});
    expect(skipped[0]).toMatch(/custom cwd/);
  });
});
