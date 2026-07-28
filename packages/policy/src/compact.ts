/**
 * Auto-compact threshold decision (S7-T7, docs/14 ADR-8).
 *
 * A pure function that answers "should this session auto-compact now?" given
 * token usage, a budget, and hysteresis state. No storage or provider
 * dependency — unit-testable in isolation, like the transition machine.
 *
 * Guards:
 *   1. Budget must be known — no ratio without a denominator.
 *   2. Not enough compactable turns — the existing `compactSession` throws
 *      on sessions with fewer than 2 turns, so don't ask it to. This is also
 *      what stops per-turn oscillation: compacting consumes the uncompacted
 *      prior turns, so nothing can re-fire until at least two new ones exist.
 *   3. Usage must exceed the trigger fraction of the budget.
 *
 * There was a fourth guard: after any compact, refuse until usage fell below
 * a `resetFraction` (0.5) that had to be lower than `triggerFraction` (0.75).
 * Since guard 3 has already established usage >= 0.75, "usage < 0.5" could
 * never hold, so the success branch was unreachable for the rest of the
 * session — one auto-compact per session, and none at all if the user had ever
 * compacted manually. Guard 2 provides the property guard 4 was reaching for,
 * without the contradiction.
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
   * How many turns could be compacted (everything before the current turn
   * that isn't already compacted). The caller computes this from session
   * state; this function rejects < 2 to match `compactSession`'s guard.
   */
  compactableTurns: number;
  /**
   * Fraction of budget at which auto-compact triggers. Default 0.75.
   */
  triggerFraction?: number;
}

/** Default trigger: compact when usage reaches 75% of budget. */
export const DEFAULT_TRIGGER_FRACTION = 0.75;

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
    compactableTurns,
  } = input;

  const triggerFraction = input.triggerFraction ?? DEFAULT_TRIGGER_FRACTION;

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

  return {
    ok: true,
    reason: `auto-compact: ${Math.round(fraction * 100)}% of budget (${usedTokens}/${budgetTokens} tokens, ${measurementMethod}), trigger at ${Math.round(triggerFraction * 100)}%`,
  };
}
