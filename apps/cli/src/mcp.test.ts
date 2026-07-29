import { describe, it, expect, vi } from "vitest";
import { mcpCommandFromCli } from "./mcp";

vi.mock("@bremio/adapter-sdk", () => ({
  McpDiscovery: vi.fn().mockReturnValue({
    discover: vi.fn(),
  }),
}));

describe("mcpCommandFromCli", () => {
  it("prints usage for no subcommand", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const code = await mcpCommandFromCli({}, ["mcp"]);

    expect(code).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Usage:"));
    log.mockRestore();
  });

  it("prints usage for --help", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const code = await mcpCommandFromCli({ help: true }, ["mcp"]);

    expect(code).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Usage:"));
    log.mockRestore();
  });

  it("returns 2 for unknown subcommand", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const code = await mcpCommandFromCli({}, ["mcp", "foo"]);

    expect(code).toBe(2);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("unknown mcp subcommand"));
    error.mockRestore();
  });

  it("handles unknown subcommand with --help flag", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const code = await mcpCommandFromCli({ help: true }, ["mcp", "foo"]);

    expect(code).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Usage:"));
    log.mockRestore();
  });
});
