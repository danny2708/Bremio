import { describe, it, expect, vi } from "vitest";
import { McpDiscovery, type McpClientHandle } from "./discovery";
import type { McpServerManifest } from "./manifest";

function mockClient(
  overrides: Partial<McpClientHandle> = {},
): McpClientHandle {
  return {
    getServerCapabilities: () => ({ tools: {} }),
    getServerVersion: () => ({ name: "mock-server", version: "1.0.0" }),
    listTools: () => Promise.resolve({ tools: [] }),
    listResources: () => Promise.resolve({ resources: [] }),
    listPrompts: () => Promise.resolve({ prompts: [] }),
    close: () => Promise.resolve(),
    ...overrides,
  };
}

function mockConnect(fn: () => McpClientHandle) {
  return vi.fn().mockImplementation(fn);
}

const stdioManifest: McpServerManifest = {
  id: "test-server",
  name: "Test Server",
  description: "A test MCP server",
  transport: { type: "stdio", command: "node", args: ["server.mjs"] },
};

describe("McpDiscovery", () => {
  it("discovers tools from a connected server", async () => {
    const client = mockClient({
      listTools: () =>
        Promise.resolve({
          tools: [
            {
              name: "echo",
              description: "Echoes input",
              inputSchema: { type: "object" as const, properties: { msg: { type: "string" } }, required: ["msg"] },
            },
          ],
        }),
    });
    const connect = mockConnect(() => client);
    const discovery = new McpDiscovery(connect);

    const results = await discovery.discover([stdioManifest]);

    expect(results).toHaveLength(1);
    expect(results[0]!.serverName).toBe("mock-server");
    expect(results[0]!.serverVersion).toBe("1.0.0");
    expect(results[0]!.tools).toHaveLength(1);
    expect(results[0]!.tools[0]!.name).toBe("echo");
    expect(results[0]!.manifest.id).toBe("test-server");
  });

  it("skips servers that fail to connect", async () => {
    const connect = mockConnect(() => {
      throw new Error("connection refused");
    });
    const discovery = new McpDiscovery(connect);

    const results = await discovery.discover([stdioManifest]);

    expect(results).toHaveLength(0);
  });

  it("discovers multiple servers", async () => {
    const connectA = mockConnect(() =>
      mockClient({
        getServerVersion: () => ({ name: "Server A", version: "1.0" }),
        listTools: () =>
          Promise.resolve({
            tools: [
              {
                name: "tool-a",
                inputSchema: { type: "object" as const },
              },
            ],
          }),
      }),
    );
    const connectB = mockConnect(() =>
      mockClient({
        getServerVersion: () => ({ name: "Server B", version: "2.0" }),
        listTools: () =>
          Promise.resolve({
            tools: [
              {
                name: "tool-b",
                inputSchema: { type: "object" as const },
              },
            ],
          }),
      }),
    );
    const manifests: McpServerManifest[] = [
      { id: "srv-a", name: "Server A", transport: { type: "stdio", command: "node", args: ["a.mjs"] } },
      { id: "srv-b", name: "Server B", transport: { type: "stdio", command: "node", args: ["b.mjs"] } },
    ];

    // Create separate discovery instances; each connect fn handles one call
    const resultsA = await new McpDiscovery(connectA).discover([manifests[0]!]);
    const resultsB = await new McpDiscovery(connectB).discover([manifests[1]!]);

    expect(resultsA).toHaveLength(1);
    expect(resultsA[0]!.serverName).toBe("Server A");
    expect(resultsA[0]!.tools[0]!.name).toBe("tool-a");
    expect(resultsB[0]!.serverName).toBe("Server B");
    expect(resultsB[0]!.tools[0]!.name).toBe("tool-b");
  });

  it("returns empty tools when server has no tool capability", async () => {
    const listToolsFn = vi.fn().mockRejectedValue(new Error("should not be called"));
    const client = mockClient({
      getServerCapabilities: () => ({}),
      listTools: listToolsFn,
    });
    const connect = mockConnect(() => client);
    const discovery = new McpDiscovery(connect);

    const results = await discovery.discover([stdioManifest]);

    expect(results).toHaveLength(1);
    expect(results[0]!.tools).toEqual([]);
    expect(listToolsFn).not.toHaveBeenCalled();
  });

  it("returns empty resources when server has no resource capability", async () => {
    const listResourcesFn = vi.fn().mockRejectedValue(new Error("should not be called"));
    const client = mockClient({
      getServerCapabilities: () => ({ tools: {} }),
      listTools: () =>
        Promise.resolve({
          tools: [
            {
              name: "greet",
              inputSchema: { type: "object" as const },
            },
          ],
        }),
      listResources: listResourcesFn,
    });
    const connect = mockConnect(() => client);
    const discovery = new McpDiscovery(connect);

    const results = await discovery.discover([stdioManifest]);

    expect(results[0]!.tools).toHaveLength(1);
    expect(results[0]!.resources).toEqual([]);
    expect(listResourcesFn).not.toHaveBeenCalled();
  });

  it("handles servers with both tools and resources", async () => {
    const client = mockClient({
      getServerCapabilities: () => ({ tools: {}, resources: {} }),
      listTools: () =>
        Promise.resolve({
          tools: [
            {
              name: "tool",
              inputSchema: { type: "object" as const },
            },
          ],
        }),
      listResources: () =>
        Promise.resolve({
          resources: [
            {
              uri: "file:///data.txt",
              name: "Data File",
            },
          ],
        }),
    });
    const connect = mockConnect(() => client);
    const discovery = new McpDiscovery(connect);

    const results = await discovery.discover([stdioManifest]);

    expect(results[0]!.tools).toHaveLength(1);
    expect(results[0]!.resources).toHaveLength(1);
    expect(results[0]!.resources[0]!.uri).toBe("file:///data.txt");
  });

  it("calls close on the client after discovery", async () => {
    const closeFn = vi.fn().mockResolvedValue(undefined);
    const client = mockClient({ close: closeFn });
    const connect = mockConnect(() => client);
    const discovery = new McpDiscovery(connect);

    await discovery.discover([stdioManifest]);

    expect(closeFn).toHaveBeenCalledOnce();
  });

  it("calls close even when listTools fails", async () => {
    const closeFn = vi.fn().mockResolvedValue(undefined);
    const client = mockClient({
      listTools: () => Promise.reject(new Error("list failed")),
      close: closeFn,
    });
    const connect = mockConnect(() => client);
    const discovery = new McpDiscovery(connect);

    const results = await discovery.discover([stdioManifest]);

    expect(closeFn).toHaveBeenCalledOnce();
    expect(results).toHaveLength(1);
    expect(results[0]!.tools).toEqual([]);
  });

  it("skips manifest when connect throws", async () => {
    const connect = vi.fn().mockRejectedValue(new Error("fail"));
    const discovery = new McpDiscovery(connect);
    const manifests: McpServerManifest[] = [
      { id: "a", name: "A", transport: { type: "stdio", command: "node", args: ["a.mjs"] } },
      { id: "b", name: "B", transport: { type: "stdio", command: "node", args: ["b.mjs"] } },
    ];

    const results = await discovery.discover(manifests);

    expect(results).toHaveLength(0);
    expect(connect).toHaveBeenCalledTimes(2);
  });
});
