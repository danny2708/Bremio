import { describe, expect, it } from "vitest";
import { AGENT_LABELS, createAdapters } from "./tui/data";

describe("opencode registration in TUI data", () => {
  it("includes opencode in the display-name map", () => {
    expect(AGENT_LABELS.opencode).toBe("OpenCode");
  });

  it("creates four adapters including opencode", () => {
    const adapters = createAdapters();
    expect(adapters).toHaveLength(4);
    const ids = adapters.map((a) => a.id);
    expect(ids).toContain("opencode");
    expect(ids).toContain("claude");
    expect(ids).toContain("codex");
    expect(ids).toContain("antigravity");
  });

  it("opencode adapter reports lead-eligible capabilities", async () => {
    const adapters = createAdapters();
    const opencode = adapters.find((a) => a.id === "opencode");
    expect(opencode).toBeDefined();
    const caps = await opencode!.getCapabilities();
    expect(caps.planning).toBe(true);
    expect(caps.structuredOutput).toBe(true);
  }, 15_000);
});
