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
      const one = (event.text ?? "").replace(/\s+/g, " ").trim();
      const clipped = one.length > 120 ? one.slice(0, 120) + "…" : one;
      return { kind: "message", summary: clipped, detail: event.text, severity: "info" };
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

