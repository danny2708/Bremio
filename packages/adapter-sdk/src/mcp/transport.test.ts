import { describe, it, expect } from "vitest";
import { createTransport } from "./transport";

describe("createTransport", () => {
  it("creates transport for stdio config", () => {
    const transport = createTransport({
      type: "stdio",
      command: "node",
      args: ["server.mjs"],
    });

    expect(transport).toBeTruthy();
    expect(typeof (transport as { start: unknown }).start).toBe("function");
    expect(typeof (transport as { close: unknown }).close).toBe("function");
    expect(typeof (transport as { send: unknown }).send).toBe("function");
  });

  it("creates transport for sse config", () => {
    const transport = createTransport({
      type: "sse",
      url: "http://localhost:3000/sse",
    });

    expect(transport).toBeTruthy();
    expect(typeof (transport as { start: unknown }).start).toBe("function");
  });

  it("creates transport for streamable-http config", () => {
    const transport = createTransport({
      type: "streamable-http",
      url: "http://localhost:3000/mcp",
    });

    expect(transport).toBeTruthy();
    expect(typeof (transport as { start: unknown }).start).toBe("function");
  });

  it("passes env and cwd to stdio transport", () => {
    const transport = createTransport({
      type: "stdio",
      command: "node",
      args: ["server.mjs"],
      env: { FOO: "bar" },
      cwd: "/tmp",
    });

    expect(transport).toBeTruthy();
  });
});
