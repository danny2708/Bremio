import { describe, expect, it } from "vitest";
import { enforceContextBudget, estimateTokens } from "./context-budget";

describe("B3: Context Budget", () => {
  it("1. uses per-provider budget from configuration without model names in core", () => {
    const config = {
      providerBudgets: {
        anthropic: 100,
        openai: 50,
      },
      defaultBudget: 200,
    };

    const resAnthropic = enforceContextBudget({
      provider: "anthropic",
      config,
      priorTurns: [],
      newPrompt: "Short prompt",
    });

    expect(resAnthropic.tokenBudget).toBe(100);
    expect(resAnthropic.allowed).toBe(true);

    const resOpenAI = enforceContextBudget({
      provider: "openai",
      config,
      priorTurns: [],
      newPrompt: "Short prompt",
    });

    expect(resOpenAI.tokenBudget).toBe(50);
    expect(resOpenAI.allowed).toBe(true);

    const resDefault = enforceContextBudget({
      provider: "local",
      config,
      priorTurns: [],
      newPrompt: "Short prompt",
    });

    expect(resDefault.tokenBudget).toBe(200);
    expect(resDefault.allowed).toBe(true);
  });

  it("2. over budget: summarises then drops older turns, never silently truncates", () => {
    // Case 2a: Turn 0 summarized (prompt + finalText replaced with summary)
    const resSummarise = enforceContextBudget({
      provider: "claude",
      config: { providerBudgets: { claude: 20 } },
      priorTurns: [
        {
          turnIndex: 0,
          prompt: "Very long initial prompt that consumes budget",
          finalText: "Very long initial response that also consumes budget",
          summary: "T0 summary", // 10 chars -> 3 tokens
        },
        {
          turnIndex: 1,
          prompt: "Short prompt", // 12 chars -> 3 tokens
          finalText: "Short res", // 9 chars -> 3 tokens
        },
      ],
      newPrompt: "New instruction", // 15 chars -> 4 tokens
    });

    expect(resSummarise.allowed).toBe(true);
    expect(resSummarise.tokenBudget).toBe(20);
    expect(resSummarise.adjustedTurns[0]?.prompt).toBe("T0 summary");
    expect(resSummarise.adjustedTurns[0]?.elided).toBe(false);

    // Case 2b: Turn 0 elided (even summary is dropped)
    const resElide = enforceContextBudget({
      provider: "claude",
      config: { providerBudgets: { claude: 15 } },
      priorTurns: [
        {
          turnIndex: 0,
          prompt: "Huge prompt " + "X".repeat(100),
          finalText: "Huge result " + "Y".repeat(100),
        },
        {
          turnIndex: 1,
          prompt: "Turn 1", // 6 chars -> 2 tokens
          finalText: "Ok", // 2 chars -> 1 token
        },
      ],
      newPrompt: "Hi", // 2 chars -> 1 token
    });

    expect(resElide.allowed).toBe(true);
    expect(resElide.tokenBudget).toBe(15);
    expect(resElide.adjustedTurns[0]?.elided).toBe(true);
    expect(resElide.adjustedTurns[1]?.elided).toBe(false);
  });

  it("3. token accounting prefers provider-reported measured usage where it exists", () => {
    const res = enforceContextBudget({
      provider: "claude",
      config: { providerBudgets: { claude: 500 } },
      priorTurns: [
        {
          turnIndex: 0,
          prompt: "prompt",
          measuredInputTokens: 150,
        },
      ],
      newPrompt: "test",
    });

    expect(res.allowed).toBe(true);
    expect(res.totalTokens).toBe(150 + Math.ceil("test".length / 4));
  });

  it("4. token accounting explicitly labels estimates as estimates, never presenting as measured", () => {
    const estimated = estimateTokens("Hello world!");
    expect(estimated.method).toBe("estimated");
    expect(estimated.isEstimate).toBe(true);
    expect(estimated.tokens).toBe(3);

    const res = enforceContextBudget({
      provider: "local",
      config: { defaultBudget: 1000 },
      priorTurns: [
        {
          turnIndex: 0,
          prompt: "Unmeasured prompt text",
        },
      ],
      newPrompt: "New instruction text",
    });

    expect(res.accountingMethod).toBe("estimated");
    expect(res.isEstimate).toBe(true);
  });

  it("5. fails closed with an explicit named reason when the budget cannot be satisfied", () => {
    const longPrompt = "X".repeat(200); // 50 tokens
    const res = enforceContextBudget({
      provider: "claude",
      config: { providerBudgets: { claude: 20 } },
      priorTurns: [],
      newPrompt: longPrompt,
    });

    expect(res.allowed).toBe(false);
    expect(res.tokenBudget).toBe(20);
    expect(res.totalTokens).toBe(50);
    expect(res.failureReason).toBe(
      "Turn instruction and diff exceed provider context budget of 20 tokens (requires 50 tokens)"
    );
  });
});
