import { describe, it, expect } from "vitest";
import { mapTool, mapTools, mapResourceActionClass } from "./capability-mapping";

describe("mapTool", () => {
  it("maps a basic tool to a descriptor", () => {
    const tool = {
      name: "echo",
      description: "Echoes input",
      inputSchema: {
        type: "object" as const,
        properties: { msg: { type: "string" } },
        required: ["msg"],
      },
    };

    const result = mapTool(tool, "srv-1");

    expect(result.serverId).toBe("srv-1");
    expect(result.name).toBe("echo");
    expect(result.description).toBe("Echoes input");
    expect(result.actionClass).toBe("mcp-tool");
  });

  it("maps a tool without description", () => {
    const tool = {
      name: "noop",
      inputSchema: { type: "object" as const },
    };

    const result = mapTool(tool, "srv-2");

    expect(result.name).toBe("noop");
    expect(result.description).toBeUndefined();
    expect(result.actionClass).toBe("mcp-tool");
  });

  it("always assigns mcp-tool action class", () => {
    const tool = {
      name: "any",
      inputSchema: { type: "object" as const },
    };

    const result = mapTool(tool, "srv");

    expect(result.actionClass).toBe("mcp-tool");
  });
});

describe("mapTools", () => {
  it("maps multiple tools", () => {
    const tools = [
      { name: "a", inputSchema: { type: "object" as const } },
      { name: "b", inputSchema: { type: "object" as const } },
    ];

    const results = mapTools(tools, "srv");

    expect(results).toHaveLength(2);
    expect(results[0]!.name).toBe("a");
    expect(results[1]!.name).toBe("b");
    expect(results.every((r) => r.serverId === "srv")).toBe(true);
  });

  it("returns empty array for empty input", () => {
    const results = mapTools([], "srv");
    expect(results).toEqual([]);
  });
});

describe("mapResourceActionClass", () => {
  it("returns 'read'", () => {
    expect(mapResourceActionClass()).toBe("read");
  });
});
