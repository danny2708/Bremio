import { describe, expect, it } from "vitest";
import {
  defaultHysteresisFloor,
  effectiveMode,
  evaluateTransition,
  isStableState,
  resolveTransitionApproval,
} from "./transition";
import type { CollaborationState, TransitionApproval, TransitionEvent } from "./transition";

/**
 * A baseline input that is always legal: a session stable in Solo for enough
 * turns to clear hysteresis, proposing Co-lab. Individual tests mutate the
 * one field under test so every guard is exercised in isolation.
 */
function baseline(overrides: Partial<Parameters<typeof evaluateTransition>[0]> = {}) {
  return {
    from: "solo" as CollaborationState,
    event: "propose-colab" as TransitionEvent,
    reason: "complexity: 4 subtasks",
    turnsInStableMode: defaultHysteresisFloor,
    minTurnsInMode: defaultHysteresisFloor,
    ...overrides,
  };
}

const APPROVED: TransitionApproval = { approved: true, via: "flag" };

describe("Solo/Co-lab transition topology (ADR-5 edges)", () => {
  // Every edge in the ADR-5 mermaid diagram, asserted as an exact (from,event,to).
  it.each([
    ["solo", "propose-colab", "proposed-colab"],
    ["proposed-colab", "approve", "colab"],
    ["proposed-colab", "decline", "solo"],
    ["colab", "propose-solo", "proposed-solo"],
    ["proposed-solo", "approve", "solo"],
    ["proposed-solo", "decline", "colab"],
    ["colab", "continue", "colab"],
  ] as const)(
    "%s --%s--> %s fires when guards pass",
    (from, event, expectedTo) => {
      const result = evaluateTransition(
        baseline({
          from,
          event,
          // approve edges need authorisation; the baseline carries none.
          ...(event === "approve" ? { approval: APPROVED } : {}),
          // colab->continue has no reason to leave a stable mode, so clear the floor.
          ...(event === "continue" ? { turnsInStableMode: 0, minTurnsInMode: 0 } : {}),
        }),
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.transition.to).toBe(expectedTo);
        expect(result.transition.from).toBe(from);
        expect(result.transition.event).toBe(event);
      }
    },
  );

  it.each([
    ["solo", "approve"],
    ["solo", "propose-solo"],
    ["solo", "continue"],
    ["colab", "propose-colab"],
    ["proposed-colab", "propose-solo"],
    ["proposed-colab", "continue"],
    ["proposed-solo", "propose-colab"],
    ["proposed-solo", "continue"],
  ] as const)("rejects %s --%s--> (no such edge)", (from, event) => {
    const result = evaluateTransition(baseline({ from, event }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe(`no edge from ${from} on ${event}`);
    }
  });
});

describe("transition records the reason verbatim", () => {
  it("carries the caller's reason on a fired transition", () => {
    const result = evaluateTransition(
      baseline({ reason: "complexity: lead counted 4 subtasks" }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.transition.reason).toBe("complexity: lead counted 4 subtasks");
    }
  });

  it("rejects a transition with an empty reason", () => {
    const result = evaluateTransition(baseline({ reason: "   " }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("transition requires a non-empty reason");
    }
  });
});

describe("hysteresis floor prevents oscillation", () => {
  it("rejects propose-colab below the floor", () => {
    const result = evaluateTransition(
      baseline({ from: "solo", event: "propose-colab", turnsInStableMode: 1, minTurnsInMode: 2 }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("hysteresis: solo has spent 1 turn(s) in mode, minimum is 2");
    }
  });

  it("rejects propose-solo below the floor", () => {
    const result = evaluateTransition(
      baseline({ from: "colab", event: "propose-solo", turnsInStableMode: 0, minTurnsInMode: 1 }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("hysteresis: colab has spent 0 turn(s) in mode, minimum is 1");
    }
  });

  it("allows propose-colab at exactly the floor", () => {
    const result = evaluateTransition(
      baseline({ from: "solo", event: "propose-colab", turnsInStableMode: 2, minTurnsInMode: 2 }),
    );
    expect(result.ok).toBe(true);
  });

  it("does not gate a pending-proposal resolution", () => {
    // A session stuck in proposed-colab must always be able to decline, even
    // at 0 turns, or hysteresis would trap it pending forever.
    const result = evaluateTransition(
      baseline({
        from: "proposed-colab",
        event: "decline",
        turnsInStableMode: 0,
        minTurnsInMode: 99,
        reason: "user declined",
      }),
    );
    expect(result.ok).toBe(true);
  });

  it("does not gate a Co-lab continue", () => {
    const result = evaluateTransition(
      baseline({
        from: "colab",
        event: "continue",
        turnsInStableMode: 0,
        minTurnsInMode: 99,
        reason: "more work to do",
      }),
    );
    expect(result.ok).toBe(true);
  });
});

describe("approve requires authorisation (fail-closed)", () => {
  it("fires when an approved transition approval is given", () => {
    const result = evaluateTransition(
      baseline({
        from: "proposed-colab",
        event: "approve",
        reason: "user approved Co-lab",
        approval: APPROVED,
        turnsInStableMode: 0,
        minTurnsInMode: 0,
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.transition.to).toBe("colab");
  });

  it("is rejected with no approval at all", () => {
    const result = evaluateTransition(
      baseline({
        from: "proposed-colab",
        event: "approve",
        reason: "user approved Co-lab",
        turnsInStableMode: 0,
        minTurnsInMode: 0,
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("approve requires an authorised transition approval");
    }
  });

  it("is rejected when the approval is explicitly denied, surfacing its reason", () => {
    const result = evaluateTransition(
      baseline({
        from: "proposed-solo",
        event: "approve",
        reason: "policy proposes Solo",
        approval: { approved: false, reason: "not a terminal; pass an explicit approval" },
        turnsInStableMode: 0,
        minTurnsInMode: 0,
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("not a terminal; pass an explicit approval");
    }
  });
});

describe("resolveTransitionApproval (mirrors resolveEscalationApproval)", () => {
  it("approves via flag without a terminal", () => {
    expect(resolveTransitionApproval({ approvedFlag: true, interactive: false })).toEqual({
      approved: true,
      via: "flag",
    });
  });

  it("is fail-closed when non-interactive and no flag", () => {
    const result = resolveTransitionApproval({ approvedFlag: false, interactive: false });
    expect(result.approved).toBe(false);
    if (!result.approved) {
      expect(result.reason).toBe("not a terminal; pass an explicit approval to change collaboration mode");
    }
  });

  it("approves via prompt when interactive and answered yes", () => {
    expect(
      resolveTransitionApproval({ approvedFlag: false, interactive: true, answer: "y" }),
    ).toEqual({ approved: true, via: "prompt" });
  });

  it("declines when interactive and answered no", () => {
    const result = resolveTransitionApproval({ approvedFlag: false, interactive: true, answer: "n" });
    expect(result.approved).toBe(false);
    if (!result.approved) expect(result.reason).toBe("mode change declined");
  });
});

describe("state helpers", () => {
  it.each([
    ["solo", "solo"],
    ["proposed-colab", "solo"],
    ["colab", "colab"],
    ["proposed-solo", "colab"],
  ] as const)("effectiveMode(%s) === %s", (state, mode) => {
    expect(effectiveMode(state)).toBe(mode);
  });

  it.each([
    ["solo", true],
    ["colab", true],
    ["proposed-colab", false],
    ["proposed-solo", false],
  ] as const)("isStableState(%s) === %s", (state, stable) => {
    expect(isStableState(state)).toBe(stable);
  });

  it("a fired transition's mode matches its target's effective mode", () => {
    const result = evaluateTransition(
      baseline({ from: "proposed-colab", event: "approve", approval: APPROVED, reason: "ok", turnsInStableMode: 0, minTurnsInMode: 0 }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.transition.mode).toBe("colab");
      expect(result.transition.mode).toBe(effectiveMode(result.transition.to));
    }
  });
});
