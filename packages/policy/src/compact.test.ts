import { describe, it, expect } from "vitest";
import {
  shouldAutoCompact,
  DEFAULT_TRIGGER_FRACTION,
  DEFAULT_RESET_FRACTION,
} from "./compact";

const FULL_POSITIVE_INPUT = {
  usedTokens: 80_000,
  budgetTokens: 100_000,
  measurementMethod: "estimated" as const,
  lastAutoCompactAtTurn: null,
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

  // ── Guard 4: hysteresis ────────────────────────────────────────────

  it("rejects when usage has not dropped below reset fraction since last auto-compact", () => {
    // Last auto-compact fired at turn 5; we're now at turn 10 with 80% usage.
    // 80% >= 50% reset → blocked by hysteresis.
    const res = shouldAutoCompact({
      ...FULL_POSITIVE_INPUT,
      usedTokens: 80_000,
      budgetTokens: 100_000,
      lastAutoCompactAtTurn: 5,

    });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("hysteresis");
    expect(res.reason).toContain("80%");
    expect(res.reason).toContain("50%");
  });

  it("allows auto-compact again when usage drops below reset fraction", () => {
    // Last auto-compact at turn 5; now at 85% usage. With trigger=0.33
    // and reset=0.5: 85% >= 33% trigger (passes Guard 3) AND
    // 85% >= 50% reset... that would still block. We need usage
    // BETWEEN trigger and reset: e.g. 44% >= 33% trigger AND 44% < 50% reset.
    const res = shouldAutoCompact({
      ...FULL_POSITIVE_INPUT,
      usedTokens: 44_000,
      budgetTokens: 100_000,
      lastAutoCompactAtTurn: 5,

      triggerFraction: 0.33,
      resetFraction: 0.5,
    });
    expect(res.ok).toBe(true);
    expect(res.reason).toContain("auto-compact");
    expect(res.reason).toContain("44%");
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

  it("uses custom trigger and reset fractions when provided", () => {
    // 60% >= 50% trigger → should fire
    const res = shouldAutoCompact({
      ...FULL_POSITIVE_INPUT,
      usedTokens: 60_000,
      budgetTokens: 100_000,
      triggerFraction: 0.5,
      resetFraction: 0.25,
    });
    expect(res.ok).toBe(true);
    expect(res.reason).toContain("60%");
    // Hysteresis: 55% >= 50% trigger (passes G3) AND 55% >= 25% reset (blocks G4)
    const hysteresis = shouldAutoCompact({
      ...FULL_POSITIVE_INPUT,
      usedTokens: 55_000,
      budgetTokens: 100_000,
      lastAutoCompactAtTurn: 9,
      triggerFraction: 0.5,
      resetFraction: 0.25,
    });
    expect(hysteresis.ok).toBe(false);
    expect(hysteresis.reason).toContain("hysteresis");
  });

  it("uses default fractions when not specified", () => {
    expect(DEFAULT_TRIGGER_FRACTION).toBe(0.75);
    expect(DEFAULT_RESET_FRACTION).toBe(0.5);
  });

  // ── First-time fire (no prior auto-compact) ────────────────────────

  it("fires on first trigger even with no prior auto-compact", () => {
    const res = shouldAutoCompact({
      ...FULL_POSITIVE_INPUT,
      lastAutoCompactAtTurn: null,
    });
    expect(res.ok).toBe(true);
  });
});
