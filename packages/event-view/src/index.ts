export interface EventView {
  kind: string;
  summary: string;
  detail?: string;
  severity: "info" | "notice" | "warn" | "error" | "success";
}

/**
 * Pure mapping from any AgentEvent-shaped object to a display model.
 * Self-contained (no module-scope references) so it can be inlined into
 * the VS Code panel webview via `.toString()`.
 */
export function renderEvent(event: {
  type: string;
  text?: string;
  name?: string;
  input?: unknown;
  ok?: boolean;
  exitCode?: number;
  detail?: string;
  message?: string;
  level?: string;
  model?: string;
  reasoningLevel?: string;
}): EventView {
  switch (event.type) {
    case "started":
      return { kind: "started", summary: "started", severity: "info" };

    case "message": {
      const text = event.text ?? event.message ?? "";
      const one = text.replace(/\s+/g, " ").trim();
      const clipped = one.length > 120 ? one.slice(0, 120) + "…" : one;
      return { kind: "message", summary: clipped, detail: text, severity: "info" };
    }

    case "thinking": {
      const one = (event.text ?? "").replace(/\s+/g, " ").trim();
      const clipped = one.length > 120 ? one.slice(0, 120) + "…" : one;
      return { kind: "thinking", summary: `· ${clipped}`, detail: event.text, severity: "notice" };
    }

    case "tool_use": {
      const input = event.input as { command?: string; file_path?: string } | undefined;
      const arg = typeof input?.command === "string"
        ? input.command
        : typeof input?.file_path === "string"
          ? input.file_path
          : "";
      return {
        kind: "tool_use",
        summary: `→ ${event.name ?? "?"}${arg ? ` ${arg}` : ""}`,
        detail: input ? JSON.stringify(input, null, 2) : undefined,
        severity: "info",
      };
    }

    case "tool_result":
      return {
        kind: "tool_result",
        summary: `${event.ok ? "✓" : "✗"} ${event.name ?? "?"} (exit code ${event.exitCode ?? "not reported"})`,
        detail: event.detail,
        severity: event.ok ? "success" : "error",
      };

    case "log": {
      const sev =
        event.level === "error" ? "error" as const
        : event.level === "warn" ? "warn" as const
        : event.level === "debug" ? "notice" as const
        : "info" as const;
      return { kind: "log", summary: event.message ?? "", severity: sev };
    }

    case "usage": {
      const model = event.model ?? "not reported";
      const reason = event.reasoningLevel ? ` [${event.reasoningLevel}]` : "";
      return { kind: "usage", summary: `${model}${reason}`, severity: "info" };
    }

    case "error":
      return { kind: "error", summary: `✗ ${event.message ?? ""}`, severity: "error" };

    case "completed":
      return { kind: "completed", summary: "✓ completed", severity: "success" };

    default: {
      const label = String(event.type);
      return { kind: label, summary: `[${label}]`, detail: JSON.stringify(event), severity: "info" };
    }
  }
}

/**
 * The agent's answer for one turn, separated from the work it did to get there.
 *
 * Every other agent CLI shows this as the main content and the tool calls as
 * subordinate detail. Bremio recorded it faithfully but no surface displayed
 * it: a run whose whole value was the reply ("could you tell me which city?")
 * rendered as `status: completed · files: 0` and nothing else.
 *
 * Two sources, because providers differ. `completed.outcome.finalText` is the
 * authoritative one when present; otherwise the streamed `message` fragments
 * are joined, since some providers only ever emit those. Fragments are
 * preferred when they are strictly longer, because a provider that both
 * streams and reports may truncate its summary.
 */
export function extractResponse(
  events: ReadonlyArray<{
    type?: string;
    kind?: string;
    text?: string;
    role?: string;
    outcome?: { finalText?: string };
    // Real events carry tool names, exit codes and more. They are ignored here,
    // but the caller must not have to strip them to pass its own events in.
    [key: string]: unknown;
  }>,
): string | undefined {
  const fragments: string[] = [];
  let finalText: string | undefined;

  for (const event of events) {
    const type = event.type ?? event.kind;
    if (type === "message" && typeof event.text === "string") {
      // `role` is absent on some providers; only an explicitly non-assistant
      // message is skipped, so a missing role is still treated as the answer.
      if (event.role === undefined || event.role === "assistant") fragments.push(event.text);
    }
    if (type === "completed" && typeof event.outcome?.finalText === "string") {
      finalText = event.outcome.finalText;
    }
  }

  const streamed = fragments.join("\n").trim();
  if (finalText && finalText.trim().length >= streamed.length) return finalText.trim();
  return streamed.length > 0 ? streamed : finalText?.trim();
}

export interface TaskExecutionInput {
  agentId?: string;
  confirmedModel?: string;
  requestedModel?: string;
  confirmedReasoningLevel?: string;
  requestedReasoningLevel?: string;
}

/**
 * Formats the execution details of an agent/task for display.
 * Shows agent, provider-confirmed model, and provider-confirmed reasoning level.
 * Says "not reported" when the provider did not report one.
 * Shows both when requested and confirmed differ.
 */
export function formatTaskExecution(input: TaskExecutionInput): string {
  const parts: string[] = [];

  if (input.agentId) {
    parts.push(`agent: ${input.agentId}`);
  }

  const confirmedModel = input.confirmedModel;
  const requestedModel = input.requestedModel;
  if (confirmedModel) {
    if (requestedModel && requestedModel !== confirmedModel) {
      parts.push(`model: ${confirmedModel} (requested: ${requestedModel})`);
    } else {
      parts.push(`model: ${confirmedModel}`);
    }
  } else {
    if (requestedModel) {
      parts.push(`model: not reported (requested: ${requestedModel})`);
    } else {
      parts.push(`model: not reported`);
    }
  }

  const confirmedReasoning = input.confirmedReasoningLevel;
  const requestedReasoning = input.requestedReasoningLevel;
  if (confirmedReasoning) {
    if (requestedReasoning && requestedReasoning !== confirmedReasoning) {
      parts.push(`reasoning: ${confirmedReasoning} (requested: ${requestedReasoning})`);
    } else {
      parts.push(`reasoning: ${confirmedReasoning}`);
    }
  } else {
    if (requestedReasoning) {
      parts.push(`reasoning: not reported (requested: ${requestedReasoning})`);
    } else {
      parts.push(`reasoning: not reported`);
    }
  }

  return parts.join(" | ");
}

export interface LaneTask {
  id: string;
  title: string;
  agentId?: string;
  model?: string;
  reasoningLevel?: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled" | "blocked";
  lastActivity: string;
  events: Array<{
    seq?: number;
    kind: string;
    summary: string;
    detail?: string;
    severity: string;
  }>;
}

export function assembleTaskLanes(
  rawEvents: Array<{
    kind?: string;
    taskId?: string;
    agentId?: string;
    message?: string;
    data?: unknown;
  }>,
): LaneTask[] {
  const lanesMap = new Map<string, LaneTask>();

  for (const rawEv of rawEvents) {
    const taskId =
      rawEv.taskId || (rawEv.kind === "lead" || rawEv.kind === "plan" ? "LEAD" : "MAIN");
    const agentId = rawEv.agentId;

    let lane = lanesMap.get(taskId);
    if (!lane) {
      lane = {
        id: taskId,
        title: taskId === "LEAD" ? "Lead Planning" : taskId === "MAIN" ? "Main Task" : taskId,
        agentId,
        status: "running",
        lastActivity: "starting",
        events: [],
      };
      lanesMap.set(taskId, lane);
    }

    if (agentId && !lane.agentId) lane.agentId = agentId;

    const dataObj =
      typeof rawEv.data === "object" && rawEv.data !== null
        ? (rawEv.data as Record<string, unknown>)
        : undefined;

    if (rawEv.kind === "plan" && dataObj?.plan) {
      const planObj = dataObj.plan as { summary?: string };
      lane.lastActivity = planObj.summary ?? rawEv.message ?? "Plan created";
      lane.status = "completed";
    }

    if (rawEv.kind === "task-start" && rawEv.message) {
      lane.title = rawEv.message;
      lane.status = "running";
    }

    if (rawEv.kind === "task-complete" && rawEv.message) {
      lane.status = rawEv.message === "completed" ? "completed" : "failed";
      lane.lastActivity = rawEv.message;
    }

    if (rawEv.kind === "failed") {
      lane.status = "failed";
      if (rawEv.message) lane.lastActivity = rawEv.message;
    }

    if (rawEv.kind === "finished") {
      lane.status = "completed";
    }

    const evType =
      rawEv.kind === "failed"
        ? "error"
        : rawEv.kind === "log" || rawEv.kind === "task-event" || !rawEv.kind
          ? "message"
          : rawEv.kind;
    const agentEv = dataObj
      ? Object.assign({ type: evType }, dataObj)
      : { type: evType, text: rawEv.message, message: rawEv.message };
    const view = renderEvent(agentEv as any);

    lane.events.push({
      kind: view.kind,
      summary: view.summary,
      ...(view.detail ? { detail: view.detail } : {}),
      severity: view.severity,
    });

    if (view.summary) {
      lane.lastActivity = view.summary;
    }

    if (view.severity === "error") {
      lane.status = "failed";
    }
  }

  return Array.from(lanesMap.values());
}


