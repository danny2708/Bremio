import { describe, expect, it } from "vitest";
import { buildAgentChoices, describeSelection } from "./screens/run";

describe("TUI agent picker", () => {
  it("offers every adapter as a worker but only capable ones as a lead", () => {
    const choices = buildAgentChoices([
      { id: "claude", capabilities: { planning: true, structuredOutput: true } },
      { id: "codex", capabilities: { planning: true, structuredOutput: true } },
      // OpenCode plans but cannot return a structured plan, so it works and
      // never leads. The picker used to omit it entirely, which meant the TUI
      // could not select a worker the CLI accepted via --worker.
      { id: "opencode", capabilities: { planning: true, structuredOutput: false } },
      { id: "antigravity", capabilities: { planning: false, structuredOutput: false } },
    ]);

    expect(choices.map((choice) => choice.id)).toEqual([
      "claude",
      "codex",
      "opencode",
      "antigravity",
    ]);
    expect(choices.filter((choice) => choice.leadEligible).map((choice) => choice.id)).toEqual([
      "claude",
      "codex",
    ]);
  });

  it("decides lead eligibility from capabilities, not from the provider's name", () => {
    // The same id, stripped of structured output, must stop being lead-eligible.
    const [claude] = buildAgentChoices([
      { id: "claude", capabilities: { planning: true, structuredOutput: false } },
    ]);
    expect(claude?.leadEligible).toBe(false);
  });
});

describe("TUI run description", () => {
  it("names the mode auto actually chose, not just 'auto'", () => {
    expect(
      describeSelection({ modeChoice: "auto", mode: "single", agentId: "claude" }),
    ).toBe("auto → single · Claude");
  });

  it("shows the lead and the worker separately in a Team run", () => {
    expect(
      describeSelection({
        modeChoice: "team",
        mode: "team",
        agentId: "claude",
        workerId: "opencode",
      }),
    ).toBe("team · Claude → OpenCode");
  });

  it("does not invent a worker for a Single run", () => {
    expect(
      describeSelection({ modeChoice: "single", mode: "single", agentId: "codex" }),
    ).toBe("single · Codex");
  });
});
