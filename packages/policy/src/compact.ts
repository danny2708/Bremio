/**
 * Auto-compact threshold decision (S7-T7, docs/14 ADR-8).
 *
 * A pure function that answers "should this session auto-compact now?" given
 * token usage, a budget, and hysteresis state. No storage or provider
 * dependency — unit-testable in isolation, like the transition machine.
 *
 * Guards (each is red-checked):
 *   1. Budget must be known — no ratio without a denominator.
 *   2. Not enough compactable turns — the existing `compactSession` throws
 *      on sessions with fewer than 2 turns, so don't ask it to.
 *   3. Usage must exceed the trigger fraction of the budget.
 *   4. Hysteresis — after an auto-compact, don't re-trigger until usage has
 *      dropped below the reset fraction (prevents per-turn oscillation).
 *
 * The measurement method (`estimated` | `measured`) is recorded in the
 * decision reason for audit but does not gate the decision — ADR-8 requires
 * reusing the harness's honest `estimated | measured` labelling, not
 * refusing to act on estimates.
 */

/**
 * The result of an auto-compact evaluation. Callers check `ok` and surface
 * `reason` verbatim — same pattern as `TransitionResult`.
 */
export type AutoCompactDecision =
  | { ok: true; reason: string }
  | { ok: false; reason: string };

export interface AutoCompactInput {
  /** Measured or estimated token usage of the session's prior turns. */
  usedTokens: number;
  /**
   * The session context budget in tokens. Must be positive for a ratio
   * to be computable.
   */
  budgetTokens: number;
  /**
   * How the token usage was determined. Labelled for audit but does not
   * gate the decision (ADR-8: honest labelling, not fail-closed on
   * estimates).
   */
  measurementMethod: "estimated" | "measured";
  /**
   * The turn index of the most recent auto-compact, or `null` if none has
   * fired yet this session. Used for hysteresis to prevent per-turn
   * oscillation.
   */
  lastAutoCompactAtTurn: number | null;
  /**
   * How many turns could be compacted (everything before the current turn
   * that isn't already compacted). The caller computes this from session
   * state; this function rejects < 2 to match `compactSession`'s guard.
   */
  compactableTurns: number;
  /**
   * Fraction of budget at which auto-compact triggers. Default 0.75.
   */
  triggerFraction?: number;
  /**
   * Fraction of budget below which the hysteresis latch resets, allowing
   * a future trigger. Must be < triggerFraction. Default 0.5.
   */
  resetFraction?: number;
}

/** Default trigger: compact when usage reaches 75% of budget. */
export const DEFAULT_TRIGGER_FRACTION = 0.75;

/** Default reset: hysteresis latch clears below 50% of budget. */
export const DEFAULT_RESET_FRACTION = 0.5;

/**
 * Evaluate whether auto-compaction should fire for this session/turn.
 *
 * Pure, deterministic, no side effects. Returns a reason string in both
 * branches so the decision is always auditable (ADR-8).
 */
export function shouldAutoCompact(input: AutoCompactInput): AutoCompactDecision {
  const {
    usedTokens,
    budgetTokens,
    measurementMethod,
    lastAutoCompactAtTurn,
    compactableTurns,
  } = input;

  const triggerFraction = input.triggerFraction ?? DEFAULT_TRIGGER_FRACTION;
  const resetFraction = input.resetFraction ?? DEFAULT_RESET_FRACTION;

  // Guard 1: budget must be known and positive.
  if (budgetTokens <= 0) {
    return {
      ok: false,
      reason: `auto-compact requires a positive budget; got ${budgetTokens}`,
    };
  }

  // Guard 2: not enough compactable turns.
  // `compactSession` throws when fewer than 2 turns exist before the
  // current one. Rejecting here keeps the decision layer honest about what
  // the storage layer can actually do.
  if (compactableTurns < 2) {
    return {
      ok: false,
      reason: `auto-compact requires at least 2 compactable turns; got ${compactableTurns}`,
    };
  }

  const fraction = usedTokens / budgetTokens;

  // Guard 3: below the trigger threshold.
  if (fraction < triggerFraction) {
    return {
      ok: false,
      reason: `usage at ${Math.round(fraction * 100)}% of budget (${measurementMethod}), below ${Math.round(triggerFraction * 100)}% trigger`,
    };
  }

  // Guard 4: hysteresis. After an auto-compact fires at turn N, don't re-fire
  // until usage has dropped below the reset fraction. This prevents
  // per-turn oscillation: without it, every subsequent turn that stays above
  // trigger would fire another compact (which would be a no-op or throw
  // because the turns are already compacted).
  if (lastAutoCompactAtTurn !== null) {
    if (fraction >= resetFraction) {
      return {
        ok: false,
        reason: `hysteresis: last auto-compact at turn ${lastAutoCompactAtTurn}; usage at ${Math.round(fraction * 100)}% has not fallen below ${Math.round(resetFraction * 100)}% reset`,
      };
    }
  }

  return {
    ok: true,
    reason: `auto-compact: ${Math.round(fraction * 100)}% of budget (${usedTokens}/${budgetTokens} tokens, ${measurementMethod}), trigger at ${Math.round(triggerFraction * 100)}%`,
  };
}
