import { describe, expect, it } from "vitest";
import { validateBenchRun } from "./bench";

describe("bremio bench run argument validation", () => {
  it("accepts a single-mode run", () => {
    expect(validateBenchRun({ mode: "single", agent: "codex", timeout: "600" })).toEqual([]);
  });

  it("accepts a team-mode run with workers", () => {
    expect(validateBenchRun({ mode: "team", lead: "claude", worker: ["codex"] })).toEqual([]);
  });

  it("requires an explicit mode", () => {
    expect(validateBenchRun({ agent: "codex" })).toContain("--mode must be single or team");
  });

  it("requires the role for the mode", () => {
    expect(validateBenchRun({ mode: "single" })).toContain("--agent <agent> is required for single mode");
    expect(validateBenchRun({ mode: "team" })).toContain("--lead <agent> is required for team mode");
  });

  it("refuses mixing single and team flags rather than guessing", () => {
    expect(validateBenchRun({ mode: "single", agent: "codex", lead: "claude" }))
      .toContain("--lead/--worker apply to team mode only");
    expect(validateBenchRun({ mode: "team", lead: "claude", agent: "codex" }))
      .toContain("--agent applies to single mode only; use --lead");
  });

  it("rejects unknown agents, a worker equal to the lead, and bad numbers", () => {
    expect(validateBenchRun({ mode: "single", agent: "ghost" }).join("\n")).toMatch(/--agent must be one of/);
    expect(validateBenchRun({ mode: "team", lead: "claude", worker: "claude" }))
      .toContain("--worker must differ from --lead");
    expect(validateBenchRun({ mode: "single", agent: "codex", timeout: "0" }))
      .toContain("--timeout must be a positive whole number of seconds");
    expect(validateBenchRun({ mode: "single", agent: "codex", reasoning: "max" }).join("\n"))
      .toMatch(/--reasoning must be one of/);
  });
});
