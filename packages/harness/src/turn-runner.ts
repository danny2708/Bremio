import { classifyAgentError } from "@bremio/adapter-sdk";
import type { AgentAdapter, AgentRunRequest } from "@bremio/adapter-sdk";
import type { AgentEvent } from "@bremio/protocol";

/**
 * Whether a resume failure means "that session is gone" rather than something
 * worth surfacing.
 *
 * The judgement is delegated to `classifyAgentError`, which exists precisely so
 * that provider wording is matched in exactly one place — its own comment says
 * a caller would otherwise "be matching strings against three unrelated error
 * formats". This module used to carry its own copy of that regex; the two were
 * identical on the day they were written, which is the only day duplicated
 * patterns ever agree. A provider rewording its message would have silently
 * turned a graceful fall-back into a hard failure, costing the user their turn.
 */
function isSessionGone(message: string): boolean {
  return classifyAgentError(message).code === "session_not_found";
}
import { assembleTurnContext, type PriorTurnContext } from "./context-assembler";
import { enforceContextBudget, type ProviderBudgetConfig, type TurnInputForBudget } from "./context-budget";

export interface TurnRunnerOptions {
  adapter: AgentAdapter;
  sessionId: string;
  turnIndex: number;
  priorTurns: Array<{
    turnIndex: number;
    prompt: string;
    finalText?: string;
    summary?: string;
    measuredInputTokens?: number;
  }>;
  providerSessionId?: string;
  currentDiff?: string;
  newPrompt: string;
  request: Omit<AgentRunRequest, "prompt">;
  budgetConfig?: ProviderBudgetConfig;
}

export interface TurnMechanismDecision {
  mechanism: "resume" | "re-inject";
  reason: string;
  providerSessionId?: string;
}

export interface TurnExecution {
  decision: TurnMechanismDecision;
  run(): AsyncIterable<AgentEvent>;
}

/**
 * Executes a follow-up turn in a session using capability-driven mechanism selection.
 *
 * - Checks adapter capabilities (`capabilities.resumableSessions`).
 * - If `resumableSessions` is true and providerSessionId is present:
 *     Attempts `adapter.resumeRun`. If provider session is expired/invalid (classified session_not_found),
 *     automatically falls back to re-injection.
 * - Otherwise:
 *     Assembles turn context (`assembleTurnContext`) and enforces context budget (`enforceContextBudget`).
 *     Invokes `adapter.startRun` with the reassembled context.
 * - Always records mechanism decision and reason (`docs/08` S4-T3).
 */
export async function prepareTurnExecution(options: TurnRunnerOptions): Promise<TurnExecution> {
  const {
    adapter,
    priorTurns,
    providerSessionId,
    currentDiff = "",
    newPrompt,
    request,
    budgetConfig,
  } = options;

  const caps = await adapter.getCapabilities();

  if (caps.resumableSessions && providerSessionId) {
    const decision: TurnMechanismDecision = {
      mechanism: "resume",
      reason: "provider capabilities.resumableSessions is true and providerSessionId is present",
      providerSessionId,
    };

    return {
      decision,
      async *run(): AsyncIterable<AgentEvent> {
        let resumeFailed = false;
        let resumeError: string | undefined;

        try {
          const stream = adapter.resumeRun(providerSessionId, {
            ...request,
            prompt: newPrompt,
          });

          for await (const ev of stream) {
            if (ev.type === "completed" && ev.outcome.status === "failed") {
              const err = ev.outcome.error ?? "";
              if (isSessionGone(err)) {
                resumeFailed = true;
                resumeError = err;
                break;
              }
            }
            yield ev;
          }
        } catch (err: unknown) {
          const msg = (err as Error).message ?? String(err);
          if (isSessionGone(msg)) {
            resumeFailed = true;
            resumeError = msg;
          } else {
            throw err;
          }
        }

        if (resumeFailed) {
          // Fall back to re-injection
          yield* runReinjectTurn({
            adapter,
            priorTurns,
            currentDiff,
            newPrompt,
            request,
            budgetConfig,
            fallbackReason: `provider session expired or unavailable (${resumeError}); fell back to re-injection`,
          });
        }
      },
    };
  }

  const fallbackReason = caps.resumableSessions
    ? "provider capabilities.resumableSessions is true but no prior providerSessionId exists"
    : "provider capabilities.resumableSessions is false";

  const decision: TurnMechanismDecision = {
    mechanism: "re-inject",
    reason: fallbackReason,
  };

  return {
    decision,
    run(): AsyncIterable<AgentEvent> {
      return runReinjectTurn({
        adapter,
        priorTurns,
        currentDiff,
        newPrompt,
        request,
        budgetConfig,
        fallbackReason,
      });
    },
  };
}

async function* runReinjectTurn(opts: {
  adapter: AgentAdapter;
  priorTurns: TurnRunnerOptions["priorTurns"];
  currentDiff: string;
  newPrompt: string;
  request: Omit<AgentRunRequest, "prompt">;
  budgetConfig?: ProviderBudgetConfig;
  fallbackReason: string;
}): AsyncIterable<AgentEvent> {
  const { adapter, priorTurns, currentDiff, newPrompt, request, budgetConfig } = opts;

  // Enforce context budget first
  const budgetRes = enforceContextBudget({
    provider: adapter.id,
    config: budgetConfig,
    priorTurns,
    currentDiff,
    newPrompt,
  });

  if (!budgetRes.allowed) {
    const now = Date.now();
    yield { type: "started", runId: request.runId, ts: now };
    yield {
      type: "completed",
      runId: request.runId,
      ts: now,
      outcome: {
        status: "failed",
        error: budgetRes.failureReason ?? "Context budget exceeded",
      },
    };
    return;
  }

  // Assemble turn context
  const priorContexts: PriorTurnContext[] = budgetRes.adjustedTurns.map((t) => ({
    turnIndex: t.turnIndex,
    prompt: t.prompt,
    finalText: t.finalText,
    summary: t.summary,
    elided: t.elided,
  }));

  const assembled = assembleTurnContext({
    priorTurns: priorContexts,
    currentDiff,
    newPrompt,
  });

  // Execute re-injected run
  yield* adapter.startRun({
    ...request,
    prompt: assembled.assembledPrompt,
  });
}
