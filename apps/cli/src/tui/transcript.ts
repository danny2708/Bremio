import { renderEvent, type EventView } from "@bremio/event-view";

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
    const events: TranscriptEventView[] = rawEvents.map((ev) => {
      const seq = typeof ev.seq === "number" ? ev.seq : 0;
      const agentEv =
        typeof ev.data === "object" && ev.data !== null
          ? { type: ev.kind ?? "log", ...ev.data }
          : { type: ev.kind ?? "log", text: ev.message, message: ev.message };

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
    };
  });

  return {
    sessionId: session.id,
    title: session.title,
    repositoryPath: session.repositoryPath,
    turns,
  };
}
