import { describe, expect, it } from "vitest";
import type { AgentRunRequest, McpPermissionCheck, McpServerManifest } from "@bremio/adapter-sdk";
import {
  buildCodexExecArgs,
  buildCodexResumeArgs,
  CodexAdapter,
  codexMcpPlan,
  codexMcpServerToml,
} from "./codex-adapter";

const allow = (): McpPermissionCheck => ({ allowed: true, approvalRequired: "none", reason: "autopilot" });

const DOCS: McpServerManifest = {
  id: "docs",
  name: "Docs",
  transport: { type: "stdio", command: "C:\\tools\\docs mcp.exe", args: ["--q", 'say "hi"'], env: { TOKEN: "a\\b" } },
};
const REMOTE: McpServerManifest = {
  id: "remote-1",
  name: "Remote",
  transport: { type: "streamable-http", url: "https://mcp.example.test/mcp" },
};

function request(overrides: Partial<AgentRunRequest> = {}): AgentRunRequest {
  return {
    runId: "run-1",
    role: "implementer",
    prompt: "do",
    cwd: "/repo",
    permission: "workspace-write",
    ...overrides,
  };
}

/** The `-c` values in argv, in order. */
function configOverrides(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) if (args[i] === "-c") out.push(args[i + 1]!);
  return out;
}

describe("codex MCP pass-through (P3-T1)", () => {
  it("adds one -c mcp_servers.<id> inline table per opted-in server", () => {
    const args = buildCodexExecArgs(request({ mcpServers: [DOCS, REMOTE], mcpToolGate: allow }), "out.txt");
    expect(configOverrides(args)).toEqual([
      'mcp_servers.docs={command="C:\\\\tools\\\\docs mcp.exe",args=["--q","say \\"hi\\""],env={"TOKEN"="a\\\\b"}}',
      'mcp_servers.remote-1={url="https://mcp.example.test/mcp"}',
    ]);
  });

  it("carries the same overrides on resume (codex -c is a global flag)", () => {
    const args = buildCodexResumeArgs("sess", request({ mcpServers: [REMOTE], mcpToolGate: allow }), "out.txt");
    expect(configOverrides(args)).toEqual(['mcp_servers.remote-1={url="https://mcp.example.test/mcp"}']);
  });

  it("attaches nothing when policy forbids MCP, and says so", () => {
    const req = request({
      mcpServers: [DOCS],
      mcpToolGate: () => ({ allowed: false, approvalRequired: "none", reason: "plan mode prohibits MCP tool use" }),
    });
    expect(configOverrides(buildCodexExecArgs(req, "out.txt"))).toEqual([]);
    expect(codexMcpPlan(req).notes[0]).toMatch(/not attached: .*plan mode prohibits MCP tool use/);
  });

  it("attaches nothing when policy wants per-call approval codex cannot ask for", () => {
    const req = request({
      mcpServers: [DOCS],
      mcpToolGate: () => ({ allowed: true, approvalRequired: "per-action", reason: "approve" }),
    });
    expect(configOverrides(buildCodexExecArgs(req, "out.txt"))).toEqual([]);
    expect(codexMcpPlan(req).notes[0]).toMatch(/cannot gate individual calls/);
  });

  it("attaches nothing without a gate (fails closed)", () => {
    expect(configOverrides(buildCodexExecArgs(request({ mcpServers: [DOCS] }), "out.txt"))).toEqual([]);
  });

  it("attaches nothing to a read-only request", () => {
    const req = request({ permission: "read-only", mcpServers: [DOCS], mcpToolGate: allow });
    expect(configOverrides(buildCodexExecArgs(req, "out.txt"))).toEqual([]);
  });

  it("refuses SSE and stdio-with-cwd with a named reason", () => {
    expect(codexMcpServerToml({ id: "s", name: "s", transport: { type: "sse", url: "https://x.test" } })).toEqual({
      skipped: expect.stringMatching(/no SSE transport/),
    });
    expect(
      codexMcpServerToml({ id: "c", name: "c", transport: { type: "stdio", command: "x", args: [], cwd: "/w" } }),
    ).toEqual({ skipped: expect.stringMatching(/cwd/) });
  });

  it("drops an id that could address another config path", () => {
    const evil: McpServerManifest = { ...REMOTE, id: "x.model" };
    expect(configOverrides(buildCodexExecArgs(request({ mcpServers: [evil], mcpToolGate: allow }), "o"))).toEqual([]);
  });

  it("reports MCP support for the transports it can carry", async () => {
    const caps = await new CodexAdapter().getRuntimeCapabilities();
    expect(caps.mcp).toBe(true);
    expect(caps.mcpTransports).toEqual(["stdio", "streamable-http"]);
  });
});
