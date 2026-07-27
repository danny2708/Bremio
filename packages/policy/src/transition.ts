import type { CollaborationMode } from "./policy";

/**
 * Solo/Co-lab transition state machine (docs/14 ADR-5).
 *
 * ```mermaid
 * stateDiagram-v2
 *     [*] --> Solo
 *     Solo --> ProposedColab: complexity signal
 *     ProposedColab --> Colab: approved (user or policy)
 *     ProposedColab --> Solo: declined
 *     Colab --> ProposedSolo: remaining work trivial
 *     ProposedSolo --> Solo: approved
 *     Colab --> Colab: continue
 * ```
 *
 * Transitions are **events in session history with a reason**, mirroring how
 * auto-mode already records its reason (`runs.ts #emit(... "auto: ...")`).
 * Hysteresis (minimum turns in a stable mode) prevents oscillation; an
 * escalation reuses the existing `resolveEscalationApproval` shape
 * (`orchestrator/single-run.ts`).
 *
 * This is a pure decision layer with no storage or provider dependency: it
 * answers "may this transition fire, and what reason would it record?" The
 * daemon persists the resulting transition as a session-config revision
 * (which already feeds the `config_change` audit kind in `storage.ts`).
 */

/**
 * The four states the machine occupies. `solo` and `colab` are stable; the
 * `proposed-*` states are the single pending decision between a stable mode
 * and a potential move to the other. Only one proposal can be in flight at a
 * time, so the diagram has no `proposed-colab` ↔ `proposed-solo` edge.
 */
export type CollaborationState = "solo" | "proposed-colab" | "colab" | "proposed-solo";

/**
 * The events the machine accepts. `propose-*` start a move out of a stable
 * mode; `approve`/`decline` resolve a pending proposal; `continue` keeps the
 * current Co-lab session going. There is intentionally no `continue` from
 * Solo: a Solo session that stays Solo records nothing, the same way a no-op
 * would.
 */
export type TransitionEvent =
  | "propose-colab"
  | "propose-solo"
  | "approve"
  | "decline"
  | "continue";

/**
 * The stable mode a state resolves to for execution. A `proposed-*` state has
 * not moved yet, so its effective mode is the stable mode it would return to
 * on a decline. This is what a run reads to decide Solo vs Co-lab execution
 * while a proposal is pending.
 */
export function effectiveMode(state: CollaborationState): CollaborationMode {
  return state === "colab" || state === "proposed-solo" ? "colab" : "solo";
}

/**
 * Whether a state is stable (no pending proposal).
 */
export function isStableState(state: CollaborationState): boolean {
  return state === "solo" || state === "colab";
}

/**
 * A transition that fired, with the reason that would be recorded in session
 * history. The reason is the durable, queryable artefact ADR-5 requires — it
 * is the analog of auto-mode's `"auto: <reason>"` event.
 */
export interface ModeTransition {
  from: CollaborationState;
  to: CollaborationState;
  /** "colab" or "solo" — the mode the session is in after this transition. */
  mode: CollaborationMode;
  /** The event that drove the transition. */
  event: TransitionEvent;
  /** Caller-supplied signal that triggered it, e.g. "complexity: 4 subtasks". */
  reason: string;
}

/**
 * Why a transition did not fire. Callers assert on `ok` and, on `false`,
 * surface `reason` verbatim — never a generic "denied" — so a rejected
 * proposal explains itself the same way auto-mode does.
 */
export type TransitionResult =
  | { ok: true; transition: ModeTransition }
  | { ok: false; reason: string };

/**
 * The legal successor for a (state, event) pair, ignoring guards. Every edge
 * in the ADR-5 diagram lives here so the guard logic and the topology cannot
 * drift apart. Returns `undefined` for a pair with no edge.
 */
function topologyNext(
  state: CollaborationState,
  event: TransitionEvent,
): CollaborationState | undefined {
  switch (state) {
    case "solo":
      return event === "propose-colab" ? "proposed-colab" : undefined;
    case "proposed-colab":
      if (event === "approve") return "colab";
      if (event === "decline") return "solo";
      return undefined;
    case "colab":
      if (event === "propose-solo") return "proposed-solo";
      if (event === "continue") return "colab";
      return undefined;
    case "proposed-solo":
      if (event === "approve") return "solo";
      if (event === "decline") return "colab";
      return undefined;
  }
}

/**
 * Whether an `approve` event is authorised. Mirrors the shape of
 * `resolveEscalationApproval` (orchestrator/single-run.ts): a pure decision
 * that is fail-closed when there is no flag and no interactive prompt to ask
 * in. Keeping it separate and pure means the guarantee "a mode change never
 * lands without authorisation" can be proven rather than asserted.
 *
 * - `approved: true` via `"flag"` — an explicit machine signal (policy, CLI).
 * - `approved: true` via `"prompt"` — a human said yes in an interactive run.
 * - `approved: false` — non-interactive with no flag, or the human said no.
 */
export type TransitionApproval =
  | { approved: true; via: "flag" | "prompt" }
  | { approved: false; reason: string };

export interface ResolveApprovalInput {
  /** An explicit machine authorisation, e.g. an autopilot policy or `--yes`. */
  approvedFlag: boolean;
  /** Whether a human can be asked. CI and pipes are not interactive. */
  interactive: boolean;
  /** The human's answer when interactive, e.g. "y"/"n". */
  answer?: string;
}

export function resolveTransitionApproval(
  input: ResolveApprovalInput,
): TransitionApproval {
  if (input.approvedFlag) return { approved: true, via: "flag" };
  if (!input.interactive) {
    return {
      approved: false,
      reason: "not a terminal; pass an explicit approval to change collaboration mode",
    };
  }
  const answer = (input.answer ?? "").trim().toLowerCase();
  if (answer === "y" || answer === "yes") return { approved: true, via: "prompt" };
  return { approved: false, reason: "mode change declined" };
}

export interface EvaluateTransitionInput {
  /** Current machine state. */
  from: CollaborationState;
  /** The event to apply. */
  event: TransitionEvent;
  /**
   * Caller-supplied reason string for whatever triggered the event. Required
   * and recorded verbatim — a transition with no reason is a transition the
   * audit log cannot explain, which ADR-5 forbids.
   */
  reason: string;
  /**
   * Hysteresis: how many completed turns the session has spent in its current
   * stable mode. A `propose-*` out of a stable mode is rejected below this
   * floor to keep the session from bouncing. Defaults to 0 (no floor) so the
   * first turn may always propose.
   */
  turnsInStableMode: number;
  /**
   * The hysteresis floor itself. Left as a parameter rather than a constant so
   * a caller can tune it (e.g. lower for an explicit user request). When
   * omitted, `defaultHysteresisFloor` applies.
   */
  minTurnsInMode: number;
  /**
   * For `approve` events: the authorisation decision. Required — an approve
   * without one never fires, which is the property ADR-5 inherits from the
   * escalation path it reuses.
   */
  approval?: TransitionApproval;
}

/**
 * Default hysteresis floor: a stable mode will not be proposed out of until
 * the session has spent at least this many turns in it. Two is the smallest
 * floor that prevents an immediate Solo→propose-colab→decline→propose-colab
 * oscillation while still allowing a second-turn complexity signal.
 */
export const defaultHysteresisFloor = 2;

/**
 * Evaluate a transition against the topology, the hysteresis floor, and the
 * approval requirement. Pure: given the same inputs it returns the same
 * result, so the rules can be unit-tested without any provider or storage.
 *
 * Order of guards is deliberate and load-bearing:
 *   1. unknown edge — reject before anything else, so an illegal transition
 *      never consults hysteresis or approval and never invents a reason.
 *   2. hysteresis — checked only on a `propose-*` out of a stable mode, so a
 *      pending proposal can always be resolved and a `continue` always fires.
 *   3. approval — checked only on `approve`, so declining needs no authority.
 */
export function evaluateTransition(
  input: EvaluateTransitionInput,
): TransitionResult {
  const { from, event, reason, turnsInStableMode } = input;

  if (reason.trim() === "") {
    return { ok: false, reason: "transition requires a non-empty reason" };
  }

  const to = topologyNext(from, event);
  if (to === undefined) {
    return {
      ok: false,
      reason: `no edge from ${from} on ${event}`,
    };
  }

  // Hysteresis applies only to a proposal that leaves a stable mode. Resolving
  // a pending proposal (approve/decline) and a Co-lab continuation are always
  // allowed: gating them would trap a session in a pending state.
  if ((event === "propose-colab" || event === "propose-solo") && isStableState(from)) {
    const floor = input.minTurnsInMode;
    if (turnsInStableMode < floor) {
      return {
        ok: false,
        reason: `hysteresis: ${from} has spent ${turnsInStableMode} turn(s) in mode, minimum is ${floor}`,
      };
    }
  }

  if (event === "approve") {
    const approval = input.approval;
    if (!approval || !approval.approved) {
      return {
        ok: false,
        reason: approval && !approval.approved
          ? approval.reason
          : "approve requires an authorised transition approval",
      };
    }
  }

  const transition: ModeTransition = {
    from,
    to,
    mode: effectiveMode(to),
    event,
    reason,
  };
  return { ok: true, transition };
}
