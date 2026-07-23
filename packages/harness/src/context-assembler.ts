export interface PriorTurnContext {
  turnIndex: number;
  prompt: string;
  status?: string;
  finalText?: string;
  error?: string;
  summary?: string;
  elided?: boolean;
}

export interface AssembleContextOptions {
  sessionTitle?: string;
  priorTurns: PriorTurnContext[];
  currentDiff?: string;
  newPrompt: string;
  maxVerbatimTurns?: number;
}

export interface AssembledContext {
  assembledPrompt: string;
  verbatimTurnCount: number;
  summarizedTurnCount: number;
  elidedTurnCount: number;
  hasDiff: boolean;
}

/**
 * Pure and synchronous assembler for context continuity.
 *
 * Given session history, current repository diff state, and the new prompt,
 * produces the lead / single agent prompt for the next turn.
 */
export function assembleTurnContext(options: AssembleContextOptions): AssembledContext {
  const {
    priorTurns,
    currentDiff,
    newPrompt,
    maxVerbatimTurns = 2,
  } = options;

  const lines: string[] = [];
  lines.push("# Session History & Context");
  lines.push("");

  let verbatimCount = 0;
  let summarizedCount = 0;
  let elidedCount = 0;

  if (priorTurns.length === 0) {
    lines.push("No prior turns in this session.");
    lines.push("");
  } else {
    lines.push("## Prior Turns");
    lines.push("");

    // Identify which active (non-elided) turns get verbatim treatment:
    // the last `maxVerbatimTurns` active turns.
    const activeTurns = priorTurns.filter((t) => !t.elided);
    const verbatimStartIndex = Math.max(0, activeTurns.length - maxVerbatimTurns);
    const verbatimTurnIndices = new Set(
      activeTurns.slice(verbatimStartIndex).map((t) => t.turnIndex),
    );

    for (const turn of priorTurns) {
      if (turn.elided) {
        elidedCount++;
        const summaryText = turn.summary ? ` (Summary: ${turn.summary})` : "";
        lines.push(`[Elided Turn ${turn.turnIndex}${summaryText}]`);
        lines.push("");
      } else if (verbatimTurnIndices.has(turn.turnIndex)) {
        verbatimCount++;
        lines.push(`### Turn ${turn.turnIndex}`);
        lines.push(`Prompt: ${turn.prompt}`);
        const outcomeText = turn.finalText
          ? turn.finalText
          : turn.error
          ? `Error: ${turn.error}`
          : turn.status ?? "completed";
        lines.push(`Outcome: ${outcomeText}`);
        lines.push("");
      } else if (turn.summary !== undefined) {
        summarizedCount++;
        lines.push(`### Turn ${turn.turnIndex} (Summary)`);
        lines.push(turn.summary);
        lines.push("");
      } else {
        // Fallback for older active turn without summary
        verbatimCount++;
        lines.push(`### Turn ${turn.turnIndex}`);
        lines.push(`Prompt: ${turn.prompt}`);
        const outcomeText = turn.finalText
          ? turn.finalText
          : turn.error
          ? `Error: ${turn.error}`
          : turn.status ?? "completed";
        lines.push(`Outcome: ${outcomeText}`);
        lines.push("");
      }
    }
  }

  lines.push("## Current Repository State");
  if (currentDiff && currentDiff.trim().length > 0) {
    lines.push("```diff");
    lines.push(currentDiff.trim());
    lines.push("```");
  } else {
    lines.push("No uncommitted changes in workspace.");
  }
  lines.push("");

  lines.push("## Current Turn Instruction");
  lines.push(newPrompt);

  const assembledPrompt = lines.join("\n");

  return {
    assembledPrompt,
    verbatimTurnCount: verbatimCount,
    summarizedTurnCount: summarizedCount,
    elidedTurnCount: elidedCount,
    hasDiff: Boolean(currentDiff && currentDiff.trim().length > 0),
  };
}
