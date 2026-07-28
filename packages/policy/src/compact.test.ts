import { describe, it, expect } from "vitest";
import { shouldAutoCompact, DEFAULT_TRIGGER_FRACTION } from "./compact";

const FULL_POSITIVE_INPUT = {
  usedTokens: 80_000,
  budgetTokens: 100_000,
  measurementMethod: "estimated" as const,
  compactableTurns: 5,
};

describe("shouldAutoCompact (S7-T7)", () => {
  // ── Guard 1: budget must be positive ───────────────────────────────

  it("rejects zero budget", () => {
    const res = shouldAutoCompact({ ...FULL_POSITIVE_INPUT, budgetTokens: 0 });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("positive budget");
  });

  it("rejects negative budget", () => {
    const res = shouldAutoCompact({ ...FULL_POSITIVE_INPUT, budgetTokens: -100 });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("positive budget");
  });

  // ── Guard 2: not enough compactable turns ──────────────────────────

  it("rejects zero compactable turns", () => {
    const res = shouldAutoCompact({ ...FULL_POSITIVE_INPUT, compactableTurns: 0 });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("at least 2");
  });

  it("rejects single compactable turn", () => {
    const res = shouldAutoCompact({ ...FULL_POSITIVE_INPUT, compactableTurns: 1 });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("at least 2");
  });

  // ── Guard 3: below trigger threshold ───────────────────────────────

  it("rejects when usage is below trigger fraction", () => {
    const res = shouldAutoCompact({
      ...FULL_POSITIVE_INPUT,
      usedTokens: 50_000,
      budgetTokens: 100_000,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("50%");
    expect(res.reason).toContain("below");
  });

  it("rejects when usage equals exactly the trigger fraction boundary", () => {
    // Just below trigger: 74.99% should reject
    const res = shouldAutoCompact({
      ...FULL_POSITIVE_INPUT,
      usedTokens: 74_990,
      budgetTokens: 100_000,
      triggerFraction: 0.75,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("75%");
  });

  // ── A session may compact more than once ───────────────────────────

  it("fires again on a later turn once new turns have accumulated", () => {
    // The property the removed reset-fraction guard destroyed. It required
    // usage < 0.5 to re-fire while guard 3 had already established usage >=
    // 0.75, so after the first compact the success branch was unreachable for
    // the rest of the session. Its own test only "passed" by inverting the
    // fractions (trigger 0.33 below reset 0.5), a configuration the input
    // documentation forbids.
    const res = shouldAutoCompact({ ...FULL_POSITIVE_INPUT, compactableTurns: 2 });
    expect(res.ok).toBe(true);
  });

  it("stops re-firing by running out of compactable turns, not by latching", () => {
    // Compacting consumes the uncompacted prior turns, so the very next turn
    // has nothing left to fold. This is what prevents per-turn oscillation.
    const justCompacted = shouldAutoCompact({ ...FULL_POSITIVE_INPUT, compactableTurns: 0 });
    expect(justCompacted.ok).toBe(false);
    expect(justCompacted.reason).toContain("at least 2");
  });

  // ── Happy paths ────────────────────────────────────────────────────

  it("allows auto-compact with estimated measurement and sufficient turn count", () => {
    const res = shouldAutoCompact(FULL_POSITIVE_INPUT);
    expect(res.ok).toBe(true);
    expect(res.reason).toContain("auto-compact");
    expect(res.reason).toContain("80%");
    expect(res.reason).toContain("estimated");
  });

  it("allows auto-compact with measured tokens", () => {
    const res = shouldAutoCompact({
      ...FULL_POSITIVE_INPUT,
      measurementMethod: "measured",
      usedTokens: 90_000,
    });
    expect(res.ok).toBe(true);
    expect(res.reason).toContain("measured");
    expect(res.reason).toContain("90%");
  });

  it("allows auto-compact at exact trigger fraction", () => {
    // 75,000 / 100,000 = 0.75
    const res = shouldAutoCompact({
      ...FULL_POSITIVE_INPUT,
      usedTokens: 75_000,
      budgetTokens: 100_000,
    });
    expect(res.ok).toBe(true);
    expect(res.reason).toContain("75%");
  });

  it("uses a custom trigger fraction when provided", () => {
    // 60% >= 50% trigger → should fire
    const res = shouldAutoCompact({
      ...FULL_POSITIVE_INPUT,
      usedTokens: 60_000,
      budgetTokens: 100_000,
      triggerFraction: 0.5,
    });
    expect(res.ok).toBe(true);
    expect(res.reason).toContain("60%");
    // 40% < 50% trigger → should not.
    const below = shouldAutoCompact({
      ...FULL_POSITIVE_INPUT,
      usedTokens: 40_000,
      budgetTokens: 100_000,
      triggerFraction: 0.5,
    });
    expect(below.ok).toBe(false);
    expect(below.reason).toContain("below");
  });

  it("uses the default trigger fraction when not specified", () => {
    expect(DEFAULT_TRIGGER_FRACTION).toBe(0.75);
  });
});
