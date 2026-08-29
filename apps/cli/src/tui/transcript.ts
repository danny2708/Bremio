import { extractResponse, renderEvent, type EventView } from "@bremio/event-view";

export interface SessionTurn {
  turnIndex: number;
  runId: string;
  prompt: string;
  status: string;
  model?: string;
  reasoningLevel?: string;
}

export interface SessionDetail {
  id: string;
  title: string;
  repositoryPath: string;
  turns: SessionTurn[];
}

export interface TranscriptEventView extends EventView {
  seq: number;
  isCollapsible: boolean;
  defaultCollapsed: boolean;
}

export interface TranscriptTurnView {
  turnIndex: number;
  runId: string;
  prompt: string;
  status: string;
  model?: string;
  reasoningLevel?: string;
  events: TranscriptEventView[];
  /** What the agent actually said, absent when it never answered. */
  response?: string;
}

export interface TranscriptViewModel {
  sessionId: string;
  title: string;
  repositoryPath: string;
  turns: TranscriptTurnView[];
}

export function assembleTranscript(
  session: SessionDetail | undefined | null,
  eventsMap: Map<string, any[]>,
): TranscriptViewModel {
  if (!session) {
    return {
      sessionId: "",
      title: "",
      repositoryPath: "",
      turns: [],
    };
  }

  const turns: TranscriptTurnView[] = (session.turns ?? []).map((turn: SessionTurn) => {
    const rawEvents = eventsMap.get(turn.runId) ?? [];
    // Persisted events keep the agent payload under `data`; the response lives
    // there, not in the envelope the daemon wraps around it.
    const response = extractResponse(
      rawEvents.map((ev) =>
        typeof ev.data === "object" && ev.data !== null
          ? { kind: ev.kind, ...ev.data }
          : { kind: ev.kind, text: ev.message },
      ),
    );
    const events: TranscriptEventView[] = rawEvents.map((ev) => {
      const seq = typeof ev.seq === "number" ? ev.seq : 0;
      const agentEv =
        typeof ev.data === "object" && ev.data !== null
          ? { type: ev.kind ?? "log", ts: ev.ts, ...ev.data }
          : { type: ev.kind ?? "log", ts: ev.ts, text: ev.message, message: ev.message };

      const view = renderEvent(agentEv as any);
      const isCollapsible = view.kind === "thinking" || view.kind === "tool_use" || view.kind === "tool_result";
      const defaultCollapsed = isCollapsible;

      return {
        ...view,
        seq,
        isCollapsible,
        defaultCollapsed,
      };
    });

    return {
      turnIndex: turn.turnIndex,
      runId: turn.runId,
      prompt: turn.prompt,
      status: turn.status,
      ...(turn.model ? { model: turn.model } : {}),
      ...(turn.reasoningLevel ? { reasoningLevel: turn.reasoningLevel } : {}),
      events,
      ...(response ? { response } : {}),
    };
  });

  return {
    sessionId: session.id,
    title: session.title,
    repositoryPath: session.repositoryPath,
    turns,
  };
}
