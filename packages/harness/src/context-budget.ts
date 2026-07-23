export type TokenAccountingMethod = "measured" | "estimated";

export interface TokenCountResult {
  tokens: number;
  method: TokenAccountingMethod;
  isEstimate: boolean;
}

export interface ProviderBudgetConfig {
  /** Map of provider or adapter identifier to token budget limit. */
  providerBudgets?: Record<string, number>;
  /** Fallback token budget limit. Default: 64000. */
  defaultBudget?: number;
}

export interface TurnInputForBudget {
  turnIndex: number;
  prompt: string;
  finalText?: string;
  summary?: string;
  measuredInputTokens?: number;
}

export interface EnforceBudgetOptions {
  provider: string;
  config?: ProviderBudgetConfig;
  priorTurns: TurnInputForBudget[];
  currentDiff?: string;
  newPrompt: string;
}

export interface AdjustedTurn {
  turnIndex: number;
  prompt: string;
  finalText?: string;
  summary?: string;
  isSummarized: boolean;
  elided: boolean;
}

export interface BudgetEnforcementResult {
  allowed: boolean;
  provider: string;
  tokenBudget: number;
  totalTokens: number;
  accountingMethod: TokenAccountingMethod;
  isEstimate: boolean;
  adjustedTurns: AdjustedTurn[];
  failureReason?: string;
}

/**
 * Estimate token count from text using 4 chars/token heuristic.
 * Explicitly labelled as estimated.
 */
export function estimateTokens(text: string): TokenCountResult {
  const tokens = Math.ceil(text.length / 4);
  return {
    tokens,
    method: "estimated",
    isEstimate: true,
  };
}

/**
 * Enforce context budget for a session turn.
 *
 * - Per-provider budget from configuration.
 * - Prefers provider-reported measured tokens when present.
 * - When over budget: summarises older turns, then elides/drops them. Never silently truncates.
 * - Fails closed if budget cannot be satisfied.
 */
export function enforceContextBudget(options: EnforceBudgetOptions): BudgetEnforcementResult {
  const {
    provider,
    config,
    priorTurns,
    currentDiff = "",
    newPrompt,
  } = options;

  const budgetMap = config?.providerBudgets ?? {};
  const tokenBudget = budgetMap[provider] ?? config?.defaultBudget ?? 64000;

  // Calculate base tokens for new prompt and current diff
  const newPromptTokens = newPrompt ? estimateTokens(newPrompt) : { tokens: 0, method: "measured" as const, isEstimate: false };
  const diffTokens = currentDiff ? estimateTokens(currentDiff) : { tokens: 0, method: "measured" as const, isEstimate: false };
  const baseTokens = newPromptTokens.tokens + diffTokens.tokens;
  const isBaseEstimated = newPromptTokens.isEstimate || diffTokens.isEstimate;

  if (baseTokens > tokenBudget) {
    return {
      allowed: false,
      provider,
      tokenBudget,
      totalTokens: baseTokens,
      accountingMethod: "estimated",
      isEstimate: true,
      adjustedTurns: [],
      failureReason: `Turn instruction and diff exceed provider context budget of ${tokenBudget} tokens (requires ${baseTokens} tokens)`,
    };
  }

  // Work with a mutable copy of turns
  const workingTurns: AdjustedTurn[] = priorTurns.map((t) => ({
    turnIndex: t.turnIndex,
    prompt: t.prompt,
    finalText: t.finalText,
    summary: t.summary,
    isSummarized: false,
    elided: false,
  }));

  function computeTotalTokens(): { total: number; isEstimate: boolean } {
    let sum = baseTokens;
    let estimated = isBaseEstimated;

    for (let i = 0; i < priorTurns.length; i++) {
      const orig = priorTurns[i]!;
      const work = workingTurns[i]!;

      if (work.elided) {
        const notice = `[Elided Turn ${work.turnIndex}${work.summary ? ` (Summary: ${work.summary})` : ""}]`;
        sum += Math.ceil(notice.length / 4);
        estimated = true;
      } else if (work.isSummarized && work.summary) {
        sum += Math.ceil(work.summary.length / 4);
        estimated = true;
      } else if (orig.measuredInputTokens !== undefined) {
        sum += orig.measuredInputTokens;
      } else {
        const text = `${work.prompt} ${work.finalText ?? ""}`;
        sum += Math.ceil(text.length / 4);
        estimated = true;
      }
    }

    return { total: sum, isEstimate: estimated };
  }

  let current = computeTotalTokens();

  // Phase 1: Summarise older turns if over budget (from oldest to newest)
  if (current.total > tokenBudget) {
    for (let i = 0; i < workingTurns.length; i++) {
      const turn = workingTurns[i]!;
      if (turn.summary && !turn.isSummarized) {
        turn.isSummarized = true;
        turn.prompt = turn.summary;
        turn.finalText = undefined;
        current = computeTotalTokens();
        if (current.total <= tokenBudget) break;
      }
    }
  }

  // Phase 2: Elide/drop oldest turns if still over budget (from oldest to newest)
  if (current.total > tokenBudget) {
    for (let i = 0; i < workingTurns.length; i++) {
      const turn = workingTurns[i]!;
      turn.elided = true;
      current = computeTotalTokens();
      if (current.total <= tokenBudget) break;
    }
  }

  // Phase 3: Check if still over budget after all turns elided
  if (current.total > tokenBudget) {
    return {
      allowed: false,
      provider,
      tokenBudget,
      totalTokens: current.total,
      accountingMethod: current.isEstimate ? "estimated" : "measured",
      isEstimate: current.isEstimate,
      adjustedTurns: workingTurns,
      failureReason: `Context budget of ${tokenBudget} tokens exceeded even after summarising and eliding all prior turns (requires ${current.total} tokens)`,
    };
  }

  return {
    allowed: true,
    provider,
    tokenBudget,
    totalTokens: current.total,
    accountingMethod: current.isEstimate ? "estimated" : "measured",
    isEstimate: current.isEstimate,
    adjustedTurns: workingTurns,
  };
}
