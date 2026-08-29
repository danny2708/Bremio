/**
 * Webview markup for the Bremio panel.
 *
 * Colour carries three separate meanings and they are never mixed:
 *   blue        = Bremio itself — brand, navigation, selection, active state
 *   yellow      = lead role, primary actions, things wanting attention
 *   agent colour = provider identity
 *
 * Yellow stays on small elements. Large yellow areas read as a warning
 * dashboard and would drown out genuine quota alerts.
 *
 * Surfaces, text and inputs come from the VS Code theme so the panel belongs to
 * the editor rather than looking like a foreign window pasted into it. Brand
 * colour is reserved for identity: logo, active tab, selection, primary action
 * and the lead badge.
 */

interface CapacityWindowView {
  label: string;
  remainingPercent?: number;
  resetsAt?: number;
  capturedAt?: number;
  freshness?: string;
  confidence?: string;
}
interface CapacitySnapshotView {
  agentId: string;
  status: string;
  confidence?: string;
  source?: { name?: string; confidenceLabel?: string };
  contactFreshness?: string;
  lastContactAt?: number;
  windows?: CapacityWindowView[];
}
export interface CapacityView {
  error?: string;
  service?: { state?: string };
  readAt?: number;
  snapshots?: CapacitySnapshotView[];
}

/**
 * Render the capacity tab from a snapshot payload.
 *
 * Self-contained (its own escape and age helpers, no module-scope references)
 * because `panelHtml` inlines its source into the webview script via
 * `.toString()` — one implementation serves both the browser panel and the
 * unit test, so a rendering test exercises the real code rather than a copy.
 *
 * The honesty rules match the CLI exactly: an unknown percentage shows as
 * `unknown`, a stale window leads with "last observed X ago" instead of stating
 * an old number as fact, and an unavailable source says so rather than blanking.
 */
export function renderCapacityCards(capacity: CapacityView): string {
  const esc = (value: unknown): string =>
    String(value ?? "").replace(
      /[&<>"']/g,
      (c) => (({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }) as Record<string, string>)[c] ?? c,
    );
  const fmtAge = (seconds: number): string => {
    if (!Number.isFinite(seconds) || seconds < 0) return "unknown";
    if (seconds < 60) return Math.round(seconds) + "s";
    if (seconds < 3600) return Math.round(seconds / 60) + "m";
    if (seconds < 86400) return (seconds / 3600).toFixed(1) + "h";
    return (seconds / 86400).toFixed(1) + "d";
  };

  if (capacity.error) return '<div class="banner bad">' + esc(capacity.error) + "</div>";

  const live = capacity.service?.state === "live";
  const banner =
    capacity.service && !live
      ? '<div class="banner warn">AI-Quota-Tray is not responding — values below are last-known, not live.</div>'
      : "";

  const readAt = typeof capacity.readAt === "number" ? capacity.readAt : undefined;

  const cards = (capacity.snapshots ?? [])
    .map((s) => {
      const statusClass = s.status === "healthy" ? "ok" : s.status === "unknown" ? "warn" : "bad";
      const unavailable = s.source?.confidenceLabel === "unavailable";
      const contactAge =
        readAt !== undefined && typeof s.lastContactAt === "number" ? fmtAge(readAt - s.lastContactAt) : undefined;

      const sourceLine =
        '<div class="muted" style="font-size:11px;margin-bottom:6px">' +
        esc(s.source?.name ?? "unknown source") +
        (s.source?.confidenceLabel ? " · " + esc(s.source.confidenceLabel) : "") +
        (s.confidence ? " (" + esc(s.confidence) + " confidence)" : "") +
        (contactAge ? " · contact " + esc(contactAge) + " ago" : "") +
        "</div>";

      const unavailableLine = unavailable
        ? '<div class="banner warn" style="margin:4px 0">SOURCE UNAVAILABLE — no data from AI-Quota-Tray</div>'
        : "";

      const windows = (s.windows ?? [])
        .map((w) => {
          const pct = w.remainingPercent;
          const known = typeof pct === "number";
          const meterClass = !known ? "" : pct >= 50 ? "" : pct >= 20 ? "warn" : "bad";
          const age = readAt !== undefined && typeof w.capturedAt === "number" ? fmtAge(readAt - w.capturedAt) : undefined;
          const reset = typeof w.resetsAt === "number" ? " · resets " + esc(new Date(w.resetsAt * 1000).toISOString()) : "";
          const fresh = w.freshness === "fresh";

          let value: string;
          if (!known) {
            value = "unknown" + reset;
          } else if (fresh) {
            value = pct.toFixed(0) + "%" + (age ? " · " + esc(age) + " old" : "") + reset;
          } else {
            value = "last observed " + (age ? esc(age) + " ago" : "unknown age") + " · " + pct.toFixed(0) + "%" + reset;
          }
          const confidenceTag = w.confidence ? " · " + esc(w.confidence) : "";

          return (
            '<div class="window">' +
            '<div class="window-label"><span class="secondary">' +
            esc(w.label) +
            "</span>" +
            '<span class="muted">' +
            value +
            confidenceTag +
            "</span></div>" +
            '<div class="meter ' +
            meterClass +
            '"><span style="width:' +
            (known ? pct : 0) +
            '%"></span></div>' +
            "</div>"
          );
        })
        .join("");

      const emptyWindows = (s.windows ?? []).length === 0 ? '<div class="muted">no quota windows reported</div>' : "";

      return (
        '<div class="card">' +
        '<div class="card-head">' +
        '<span class="agent" data-agent="' +
        esc(s.agentId) +
        '"><span class="card-title">' +
        esc(s.agentId) +
        "</span></span>" +
        '<span class="badge ' +
        statusClass +
        '">' +
        esc(s.status) +
        "</span>" +
        '<div class="spacer"></div>' +
        '<span class="muted">contact ' +
        esc(s.contactFreshness ?? "unknown") +
        "</span>" +
        "</div>" +
        sourceLine +
        unavailableLine +
        windows +
        emptyWindows +
        "</div>"
      );
    })
    .join("");

  return banner + cards;
}

export interface DecisionReasonMessage {
  fallbackReason?: string;
  autoModeReason?: string;
}

/**
 * Markup for *why* an automatic choice was made — a Team run falling back to
 * Single, or Auto mode picking a flow.
 *
 * Self-contained and exported for the same reason `renderCapacityCards` is:
 * `panelHtml` inlines its source into the webview script, so the panel and the
 * test exercise one implementation. Asserting on the script *text* instead
 * would pass even with the branch disabled, which is no assertion at all.
 */
export function renderDecisionReasons(message: DecisionReasonMessage): string {
  const esc = (value: unknown): string =>
    String(value ?? "").replace(
      /[&<>"']/g,
      (c) => (({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }) as Record<string, string>)[c] ?? c,
    );
  let out = "";
  if (message.fallbackReason) {
    out += '<div class="banner warn"><strong>Team fallback</strong><br>' + esc(message.fallbackReason) + "</div>";
  }
  if (message.autoModeReason) {
    out += '<div class="card"><span class="muted">auto mode: ' + esc(message.autoModeReason) + "</span></div>";
  }
  return out;
}

/**
 * Self-contained (no module-scope references) because `panelHtml` inlines its
 * source into the webview script via .toString(), matching the pattern used by
 * `renderCapacityCards`. Canonical source: packages/event-view/src/index.ts.
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
}): { kind: string; summary: string; detail?: string; severity: string } {
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
      return { kind: "thinking", summary: "· " + clipped, detail: event.text, severity: "notice" };
    }
    case "tool_use": {
      const input = (typeof event.input === "object" && event.input) ? event.input as Record<string, unknown> : undefined;
      const command = input?.command;
      const file_path = input?.file_path;
      const arg = typeof command === "string" ? command : typeof file_path === "string" ? file_path : "";
      return {
        kind: "tool_use",
        summary: "→ " + (event.name ?? "?") + (arg ? " " + arg : ""),
        detail: input ? JSON.stringify(input, null, 2) : undefined,
        severity: "info",
      };
    }
    case "tool_result":
      return {
        kind: "tool_result",
        summary: (event.ok ? "✓" : "✗") + " " + (event.name ?? "?") + " (exit code " + (event.exitCode ?? "not reported") + ")",
        detail: event.detail,
        severity: event.ok ? "success" : "error",
      };
    case "log": {
      const sev = event.level === "error" ? "error" : event.level === "warn" ? "warn" : event.level === "debug" ? "notice" : "info";
      return { kind: "log", summary: event.message ?? "", severity: sev };
    }
    case "usage": {
      const model = event.model ?? "not reported";
      const reason = event.reasoningLevel ? " [" + event.reasoningLevel + "]" : "";
      return { kind: "usage", summary: model + reason, severity: "info" };
    }
    case "error":
      return { kind: "error", summary: "✗ " + (event.message ?? ""), severity: "error" };
    case "completed":
      return { kind: "completed", summary: "✓ completed", severity: "success" };
    default: {
      const label = String(event.type);
      return { kind: label, summary: "[" + label + "]", detail: JSON.stringify(event), severity: "info" };
    }
  }
}

/**
 * Self-contained (no module-scope references) because `panelHtml` inlines its
 * source into the webview script via .toString(), matching `renderEvent`.
 * Canonical source: packages/event-view/src/index.ts (`extractResponse`).
 *
 * A drift test runs both copies over the same inputs and asserts they agree.
 */
export function extractResponse(
  events: ReadonlyArray<Record<string, unknown>>,
): string | undefined {
  const fragments: string[] = [];
  let finalText: string | undefined;

  for (const event of events) {
    const type = (event.type ?? event.kind) as string | undefined;
    if (type === "message" && typeof event.text === "string") {
      const role = event.role as string | undefined;
      if (role === undefined || role === "assistant") fragments.push(event.text);
    }
    if (type === "completed") {
      const outcome = event.outcome as { finalText?: string } | undefined;
      if (typeof outcome?.finalText === "string") finalText = outcome.finalText;
    }
  }

  const streamed = fragments.join("\n").trim();
  if (finalText && finalText.trim().length >= streamed.length) return finalText.trim();
  return streamed.length > 0 ? streamed : finalText ? finalText.trim() : undefined;
}

/**
 * Self-contained (no module-scope references) because `panelHtml` inlines its
 * source into the webview script via .toString(), matching `renderEvent`.
 * Canonical source: packages/event-view/src/index.ts.
 */
export function formatTaskExecution(input: {
  agentId?: string;
  confirmedModel?: string;
  requestedModel?: string;
  confirmedReasoningLevel?: string;
  requestedReasoningLevel?: string;
}): string {
  const parts: string[] = [];
  if (input.agentId) parts.push("agent: " + input.agentId);

  const confirmedModel = input.confirmedModel;
  const requestedModel = input.requestedModel;
  if (confirmedModel) {
    if (requestedModel && requestedModel !== confirmedModel) {
      parts.push("model: " + confirmedModel + " (requested: " + requestedModel + ")");
    } else {
      parts.push("model: " + confirmedModel);
    }
  } else {
    if (requestedModel) {
      parts.push("model: not reported (requested: " + requestedModel + ")");
    } else {
      parts.push("model: not reported");
    }
  }

  const confirmedReasoning = input.confirmedReasoningLevel;
  const requestedReasoning = input.requestedReasoningLevel;
  if (confirmedReasoning) {
    if (requestedReasoning && requestedReasoning !== confirmedReasoning) {
      parts.push("reasoning: " + confirmedReasoning + " (requested: " + requestedReasoning + ")");
    } else {
      parts.push("reasoning: " + confirmedReasoning);
    }
  } else {
    if (requestedReasoning) {
      parts.push("reasoning: not reported (requested: " + requestedReasoning + ")");
    } else {
      parts.push("reasoning: not reported");
    }
  }

  return parts.join(" | ");
}

/**
 * Parse a unified-diff patch and return HTML with syntax-highlighted lines.
 * Self-contained (no module-scope references) because `panelHtml` inlines its
 * source into the webview script via `.toString()`, matching `renderCapacityCards`.
 */
export function renderDiffViewer(diff: { stat: string; patch: string }): string {
  const esc = (value: unknown): string =>
    String(value ?? "").replace(
      /[&<>"']/g,
      (c) => (({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }) as Record<string, string>)[c] ?? c,
    );
  if (!diff.patch && !diff.stat) return '<div class="muted">No changes in this run.</div>';

  const statHtml = diff.stat
    ? '<div class="diff-stat">' + esc(diff.stat).replace(/\n/g, "<br>") + "</div>"
    : "";

  const highlight = (line: string): string => {
    if (line.startsWith("+") && !line.startsWith("+++")) {
      return '<div class="diff-add">' + esc(line) + "</div>";
    }
    if (line.startsWith("-") && !line.startsWith("---")) {
      return '<div class="diff-remove">' + esc(line) + "</div>";
    }
    if (line.startsWith("@")) return '<div class="diff-hunk">' + esc(line) + "</div>";
    if (
      line.startsWith("diff --git") || line.startsWith("index ")
      || line.startsWith("---") || line.startsWith("+++")
    ) {
      return '<div class="diff-meta">' + esc(line) + "</div>";
    }
    return "<div>" + esc(line) + "</div>";
  };

  // Split the patch per file so each one can be applied or reverted on its
  // own (S10-T5). The post-image path is taken from the `diff --git a/x b/y`
  // header rather than by splitting on whitespace, which loses paths that
  // contain spaces — the same parsing the workspace package settled on.
  const fileOf = (line: string): string | undefined => {
    if (!line.startsWith("diff --git ")) return undefined;
    const rest = line.slice("diff --git ".length);
    if (!rest.startsWith("a/")) return undefined;
    const marker = " b/";
    for (let i = rest.indexOf(marker); i !== -1; i = rest.indexOf(marker, i + 1)) {
      if (rest.slice(2, i) === rest.slice(i + marker.length)) return rest.slice(i + marker.length);
    }
    const last = rest.lastIndexOf(marker);
    return last === -1 ? undefined : rest.slice(last + marker.length);
  };

  const sections: Array<{ file?: string; html: string }> = [];
  let current: { file?: string; html: string } | undefined;
  for (const line of diff.patch.split("\n")) {
    const file = fileOf(line);
    if (file !== undefined) {
      current = { file, html: "" };
      sections.push(current);
    } else if (!current) {
      // A patch with no `diff --git` header at all: one unnamed section, whole
      // run only. Offering per-file buttons here would name files we cannot
      // identify.
      current = { html: "" };
      sections.push(current);
    }
    current.html += highlight(line);
  }

  const fileButtons = (file: string): string =>
    '<div class="diff-file-actions">'
    + '<button class="ghost" data-action="apply-diff" data-file="' + esc(file) + '">Apply file</button>'
    + '<button class="ghost" data-action="revert-diff" data-file="' + esc(file) + '">Revert file</button>'
    + "</div>";

  const body = sections.map((section) => {
    if (!section.file) return '<pre class="diff-patch">' + section.html + "</pre>";
    return '<details class="diff-file" open>'
      + "<summary>" + esc(section.file) + "</summary>"
      + fileButtons(section.file)
      + '<pre class="diff-patch">' + section.html + "</pre>"
      + "</details>";
  }).join("");

  return '<div class="diff-viewer">'
    + '<div class="diff-header"><span class="card-title">Diff</span></div>'
    + statHtml
    + body
    + '<div class="row" style="margin-top:8px">'
    + '<button class="ghost" data-action="apply-diff">Apply all</button>'
    + '<button class="ghost" data-action="revert-diff">Revert all</button>'
    + '<div class="spacer"></div>'
    + '<button class="ghost" data-action="back-to-gate">Back</button>'
    + "</div></div>";
}

export function renderLogLine(event: { kind?: string; taskId?: string; message?: string; data?: unknown }): {
  summary: string;
  detail?: string;
  kind: string;
  severity: string;
} {
  const agentEv =
    typeof event.data === "object" && event.data !== null
      ? Object.assign({ type: event.kind || "log" }, event.data)
      : { type: event.kind || "log", text: event.message, message: event.message };
  const view = renderEvent(agentEv as any);
  return {
    summary: view.summary,
    detail: view.detail,
    kind: view.kind,
    severity: view.severity,
  };
}

/**
 * The lead's plan as a checklist (S10-T3).
 *
 * Distinct from `assembleTaskLanes`, which builds a lane per task id it has
 * *seen an event for* — so a task the scheduler has not reached yet does not
 * exist in it. A checklist has to show those: "three of five done, one running,
 * one waiting on it" is the whole point, and the two not started are the part
 * lanes cannot express.
 *
 * The plan arrives once, on the `plan` event, carrying every task and the
 * agent each was assigned to. Status then comes from the task lifecycle events
 * layered on top. Pure and event-sourced, so a finished turn replays to exactly
 * what was shown live.
 */
export function assemblePlanChecklist(
  rawEvents: Array<{
    kind?: string;
    taskId?: string;
    agentId?: string;
    message?: string;
    data?: unknown;
  }>,
): {
  summary?: string;
  tasks: Array<{
    id: string;
    title: string;
    agentId?: string;
    status: "pending" | "running" | "completed" | "failed";
    dependsOn: string[];
  }>;
} {
  const tasks = new Map<string, {
    id: string;
    title: string;
    agentId?: string;
    status: "pending" | "running" | "completed" | "failed";
    dependsOn: string[];
  }>();
  let summary: string | undefined;

  for (const event of rawEvents) {
    const data =
      typeof event.data === "object" && event.data !== null
        ? (event.data as Record<string, unknown>)
        : undefined;

    if (event.kind === "plan" && data?.plan) {
      const plan = data.plan as {
        summary?: string;
        tasks?: Array<{ id?: string; title?: string; dependencies?: string[] }>;
      };
      if (plan.summary) summary = plan.summary;
      const assign = (data.assign ?? {}) as Record<string, string>;
      for (const task of plan.tasks ?? []) {
        if (!task.id) continue;
        tasks.set(task.id, {
          id: task.id,
          title: task.title ?? task.id,
          ...(assign[task.id] ? { agentId: assign[task.id] } : {}),
          status: "pending",
          dependsOn: task.dependencies ?? [],
        });
      }
      continue;
    }

    if (!event.taskId) continue;
    // A task the plan never mentioned still gets an entry rather than being
    // dropped: work that happened is work the user should see.
    const existing = tasks.get(event.taskId) ?? {
      id: event.taskId,
      title: event.taskId,
      status: "pending" as const,
      dependsOn: [],
    };
    if (event.agentId && !existing.agentId) existing.agentId = event.agentId;

    if (event.kind === "task-start") {
      existing.status = "running";
      if (event.message) existing.title = event.message;
    } else if (event.kind === "task-complete") {
      existing.status = event.message === "completed" ? "completed" : "failed";
    }
    tasks.set(event.taskId, existing);
  }

  return { ...(summary ? { summary } : {}), tasks: [...tasks.values()] };
}

export function assembleTaskLanes(
  rawEvents: Array<{
    kind?: string;
    taskId?: string;
    agentId?: string;
    message?: string;
    data?: unknown;
  }>,
): Array<{
  id: string;
  title: string;
  agentId?: string;
  status: string;
  lastActivity: string;
  events: Array<{ kind: string; summary: string; detail?: string; severity: string }>;
}> {
  const lanesMap = new Map<string, {
    id: string;
    title: string;
    agentId?: string;
    status: string;
    lastActivity: string;
    events: Array<{ kind: string; summary: string; detail?: string; severity: string }>;
  }>();

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

export function panelHtml(nonce: string, cspSource: string, iconUri = ""): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} data:; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Bremio</title>
<style>
/*
 * Surfaces come from VS Code, brand colour does not.
 *
 * A fixed dark palette made the panel look like a foreign window pasted into
 * the editor, and broke outright under a light theme. Everything structural now
 * uses VS Code's own theme variables, so the panel matches whatever the user
 * chose. The Bremio palette is kept for identity only: the logo, the active
 * tab, selection borders, the primary action, and the lead badge.
 */
:root {
  --bremio-primary: #2563eb;
  --bremio-primary-hover: #3b82f6;
  --bremio-accent: #f4c542;
  --bremio-accent-hover: #ffd75e;
  --bremio-accent-ink: #241d00;

  /* Provider identity, desaturated so it never competes with the brand. */
  --agent-claude: #c9864a;
  --agent-codex: #34a77b;
  --agent-antigravity: #7c83f6;
  --agent-opencode: #a071d1;
  --agent-jan: #32b8c6;

  /* Structure: the editor's own tokens, with fallbacks for older hosts. */
  --surface: var(--vscode-editor-background, transparent);
  --surface-raised: var(--vscode-editorWidget-background, rgba(127, 127, 127, 0.08));
  --border: var(--vscode-widget-border, var(--vscode-panel-border, rgba(127, 127, 127, 0.28)));
  --text: var(--vscode-foreground, inherit);
  --text-muted: var(--vscode-descriptionForeground, rgba(127, 127, 127, 0.9));
  --hover: var(--vscode-list-hoverBackground, rgba(127, 127, 127, 0.12));
  --success: var(--vscode-testing-iconPassed, #3fb950);
  --danger: var(--vscode-errorForeground, #f85149);
}

* { box-sizing: border-box; }

/*
 * The composer groups the prompt with its actions in one bordered block, so
 * attaching context reads as part of writing the request rather than a
 * separate setting elsewhere on the form.
 */
.composer {
  border: 1px solid var(--vscode-input-border, var(--border));
  border-radius: 8px;
  background: var(--vscode-input-background, transparent);
  padding: 6px;
}
.composer:focus-within { border-color: var(--bremio-primary); }
.composer textarea {
  border: none; background: transparent; padding: 6px; min-height: 76px;
}
.composer textarea:focus { outline: none; }
.composer-actions {
  display: flex; align-items: center; gap: 6px; padding: 4px 4px 2px;
  flex-wrap: wrap;
}
.composer-actions .spacer { min-width: 0; }
.hint { margin: 8px 2px 0; font-size: 11px; }

/*
 * The panel usually lives in a side column, so a narrow layout is the normal
 * case. Below this width the action buttons stack to full width instead of
 * being squeezed into unreadable slivers.
 */
@media (max-width: 420px) {
  .composer-actions { gap: 6px; }
  .composer-actions .spacer { display: none; }
  .composer-actions button { flex: 1 1 auto; justify-content: center; }
  .composer-actions button.primary { flex-basis: 100%; }
  header { flex-wrap: wrap; row-gap: 4px; }
  .tagline { display: none; }
  nav { overflow-x: auto; }
  nav button { white-space: nowrap; }
}

button.icon { display: inline-flex; align-items: center; gap: 5px; padding: 4px 9px; font-size: 11px; }
button.icon .glyph { font-size: 13px; line-height: 1; }

.attachments { display: flex; flex-wrap: wrap; gap: 5px; padding: 0 4px; }
.attachments:not(:empty) { padding: 4px; }
.chip {
  display: inline-flex; align-items: center; gap: 6px;
  border: 1px solid var(--border); border-radius: 999px;
  padding: 2px 6px 2px 9px; font-size: 11px; color: var(--text);
  background: var(--surface-raised); max-width: 260px;
}
.chip .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chip button {
  border: none; background: none; cursor: pointer; color: var(--text-muted);
  font-size: 13px; line-height: 1; padding: 0 2px;
}
.chip button:hover { color: var(--danger); }

body {
  margin: 0;
  background: var(--surface);
  color: var(--text);
  font-family: var(--vscode-font-family, system-ui, sans-serif);
  font-size: var(--vscode-font-size, 13px);
  line-height: 1.5;
}

header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
  background: transparent;
}

.logo { width: 24px; height: 24px; border-radius: 6px; flex: none; display: block; }
.wordmark { font-weight: 600; letter-spacing: .2px; white-space: nowrap; }
.tagline { color: var(--text-muted); font-size: 11px; }
.spacer { flex: 1; }

.status-dot {
  width: 8px; height: 8px; border-radius: 50%;
  background: var(--text-muted);
  flex: none;
}
#daemon-detail { font-size: 11px; color: var(--text-muted); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.status-dot.live { background: var(--success); }
.status-dot.down { background: var(--danger); }

nav { display: flex; gap: 2px; padding: 0 12px; background: transparent; border-bottom: 1px solid var(--border); }
nav button {
  background: none; border: none; border-bottom: 2px solid transparent;
  color: var(--text-muted); padding: 9px 12px; cursor: pointer;
  font-size: 12px; font-family: inherit;
}
nav button:hover { color: var(--text); background: var(--hover); border-radius: 4px 4px 0 0; }
/* Blue marks where you are — system state, never an action. */
nav button.active { color: var(--text); border-bottom-color: var(--bremio-primary); }

main { padding: 16px; }
section { display: none; }
section.active { display: block; }

.card {
  background: transparent;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px 14px;
  margin-bottom: 10px;
}
.card-head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.card-title { font-weight: 600; }

.badge {
  font-size: 10px; text-transform: uppercase; letter-spacing: .6px;
  padding: 2px 6px; border-radius: 4px; font-weight: 700;
}
/* Yellow = the lead role. One badge, never a whole surface. */
.badge.lead { background: var(--bremio-accent); color: var(--bremio-accent-ink); }
.badge.ok { background: color-mix(in srgb, var(--bremio-primary) 18%, transparent); color: var(--bremio-primary-hover); }
.badge.warn { background: color-mix(in srgb, var(--bremio-accent) 20%, transparent); color: var(--bremio-accent-hover); }
.badge.bad { background: color-mix(in srgb, var(--danger) 18%, transparent); color: var(--danger); }

.agent { display: inline-flex; align-items: center; gap: 6px; }
.agent::before { content: ""; width: 8px; height: 8px; border-radius: 2px; background: var(--text-muted); }
.agent[data-agent="claude"]::before { background: var(--agent-claude); }
.agent[data-agent="codex"]::before { background: var(--agent-codex); }
.agent[data-agent="antigravity"]::before { background: var(--agent-antigravity); }

.meter { height: 6px; border-radius: 3px; background: var(--surface-raised); overflow: hidden; margin-top: 4px; }
.meter > span { display: block; height: 100%; background: var(--bremio-primary); }
.meter.warn > span { background: var(--bremio-accent); }
.meter.bad > span { background: var(--danger); }

.muted { color: var(--text-muted); }
.secondary { color: var(--text); opacity: .85; }
.row { display: flex; align-items: center; gap: 8px; }
.between { justify-content: space-between; }
.window { margin: 8px 0; }
.window-label { display: flex; justify-content: space-between; font-size: 11px; }

label { display: block; font-size: 11px; color: var(--text-muted); margin: 10px 0 4px; }
input, select, textarea {
  width: 100%;
  background: var(--vscode-input-background, transparent);
  color: var(--vscode-input-foreground, var(--text));
  border: 1px solid var(--vscode-input-border, var(--border));
  border-radius: 6px;
  padding: 7px 9px; font-family: inherit; font-size: 12px;
}
input:focus, select:focus, textarea:focus { outline: none; border-color: var(--bremio-primary); }
textarea { resize: vertical; min-height: 72px; }

.seg { display: flex; gap: 6px; }
.seg button {
  flex: 1; padding: 7px; border-radius: 6px; cursor: pointer; font-family: inherit; font-size: 12px;
  background: transparent; color: var(--text-muted);
  border: 1px solid var(--border);
}
.seg button:hover { background: var(--hover); color: var(--text); }
/* Selection is system state, so it is blue. */
.seg button.on { border-color: var(--bremio-primary); color: var(--text); background: color-mix(in srgb, var(--bremio-primary) 15%, transparent); }

button.primary {
  /* The one action on the screen — yellow, and small. */
  background: var(--bremio-accent); color: var(--bremio-accent-ink); border: none;
  padding: 8px 16px; border-radius: 6px; font-weight: 600; cursor: pointer;
  font-family: inherit; font-size: 12px;
}
button.primary:hover { background: var(--bremio-accent-hover); }
button.primary:active { background: var(--bremio-accent); }
button.primary:disabled { background: var(--surface-raised); color: var(--text-muted); cursor: not-allowed; }

button.ghost {
  background: none; border: 1px solid var(--border); color: var(--text-muted);
  padding: 6px 12px; border-radius: 6px; cursor: pointer; font-family: inherit; font-size: 12px;
}
button.ghost:hover { border-color: var(--bremio-primary); color: var(--text); background: var(--hover); }

pre.log {
  background: var(--vscode-textCodeBlock-background, var(--surface-raised));
  border: 1px solid var(--border); border-radius: 6px;
  padding: 10px; max-height: 320px; overflow: auto; resize: vertical; font-size: 11px;
  font-family: var(--vscode-editor-font-family, monospace); white-space: pre-wrap; margin: 0;
}
.log-line { display: block; }
.log-task { color: var(--bremio-primary-hover); }
.log-lead { color: var(--bremio-accent); }
.log-fail { color: var(--danger); }
.log-done { color: var(--success); }

.empty { color: var(--text-muted); padding: 24px; text-align: center; }
.banner { border-radius: 6px; padding: 8px 10px; margin-bottom: 10px; font-size: 12px; }
/* Tint the theme's own accent/danger rather than a fixed hex, so the banner is
 * legible on light themes too — the old #3a1c1e navy was invisible on white,
 * and --bremio-accent-muted was never defined, leaving warn with no fill. */
.banner.warn { background: color-mix(in srgb, var(--bremio-accent) 16%, transparent); color: var(--bremio-accent-hover); }
.banner.bad { background: color-mix(in srgb, var(--danger) 16%, transparent); color: var(--danger); }
.banner.ok { background: color-mix(in srgb, var(--ok, #3fb950) 14%, transparent); color: var(--ok, #3fb950); }

/* Session transcript: a conversation, so the two speakers are visually
 * distinct and the agent's answer is the most prominent thing on screen.
 * The work it did to get there is subordinate, collapsed by default. */
.session-row { display: flex; gap: 8px; align-items: baseline; padding: 6px 8px; border-radius: 6px; cursor: pointer; }
.session-row:hover { background: color-mix(in srgb, var(--bremio-accent) 10%, transparent); }
.session-row .title { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.turn { margin: 0 0 22px; }
.speaker { font-weight: 600; font-size: 11px; letter-spacing: .04em; text-transform: uppercase; margin-bottom: 5px; display: flex; align-items: baseline; gap: 6px; }
.speaker.you { color: var(--bremio-accent-hover); }
.speaker.agent { color: var(--fg); }
.bubble { white-space: pre-wrap; word-break: break-word; margin-bottom: 10px; }
/* The prompt is what you said: a quoted card, so it reads as the question
 * rather than as more output. */
.bubble.prompt {
  background: color-mix(in srgb, var(--bremio-accent) 8%, transparent);
  border-left: 2px solid color-mix(in srgb, var(--bremio-accent) 45%, transparent);
  border-radius: 0 6px 6px 0; padding: 8px 10px; font-size: 13px; line-height: 1.5;
}
.bubble.response { font-size: 13px; line-height: 1.55; white-space: normal; }
/* Markdown inside a reply. The agent writes prose, lists and code; rendering
 * it as one pre-wrapped blob made a JSON answer an unreadable wall. */
.md > *:first-child { margin-top: 0; }
.md > *:last-child { margin-bottom: 0; }
.md p { margin: 0 0 8px; }
.md h1, .md h2, .md h3 { font-size: 13px; font-weight: 600; margin: 14px 0 6px; line-height: 1.3; }
.md h1 { font-size: 15px; }
.md h2 { font-size: 14px; }
.md ul, .md ol { margin: 0 0 8px; padding-left: 20px; }
.md li { margin: 2px 0; }
.md code {
  font-family: var(--vscode-editor-font-family, monospace); font-size: 12px;
  background: color-mix(in srgb, var(--fg) 10%, transparent); padding: 1px 4px; border-radius: 3px;
}
.md pre {
  font-family: var(--vscode-editor-font-family, monospace); font-size: 12px;
  background: color-mix(in srgb, var(--fg) 7%, transparent); border: 1px solid var(--border);
  border-radius: 6px; padding: 8px 10px; margin: 0 0 8px; overflow-x: auto; white-space: pre;
}
.md pre code { background: none; padding: 0; }
.md blockquote { margin: 0 0 8px; padding-left: 10px; border-left: 2px solid var(--border); color: var(--muted); }
.md a { color: var(--bremio-accent-hover); }
.md hr { border: 0; border-top: 1px solid var(--border); margin: 12px 0; }
/* The process log is reference material, not the answer: dimmed, monospaced
 * and scrollable so a thousand tool calls cannot push the reply off screen. */
.process { font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; color: var(--muted); max-height: 260px; overflow: auto; resize: vertical; min-height: 48px; margin-bottom: 8px; }
.process summary { cursor: pointer; }
.process div { white-space: pre-wrap; word-break: break-all; }
.turn-foot { font-size: 11px; color: var(--muted); }

/* Working-tree changes, staged and unstaged. */
.git-list { border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
.git-row { display: flex; align-items: center; gap: 8px; padding: 4px 8px; font-size: 12px; cursor: pointer; }
.git-row:hover { background: color-mix(in srgb, var(--fg) 6%, transparent); }
.git-row + .git-row { border-top: 1px solid var(--border); }
.git-status {
  flex: 0 0 auto; width: 68px; font-size: 10px; color: var(--muted);
  text-transform: uppercase; letter-spacing: .03em;
}
.git-status.modified { color: var(--bremio-accent-hover); }
.git-status.deleted { color: var(--danger); }
.git-status.untracked, .git-status.added { color: var(--ok, #3fb950); }
.git-path { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--vscode-editor-font-family, monospace); }
#git-message { width: 100%; }

/* The checked-out branch. Apply and merge act relative to it, so it belongs
 * where the user can see it without going looking. */
.branch-label {
  font-size: 11px; color: var(--muted); border: 1px solid var(--border);
  border-radius: 10px; padding: 1px 8px; max-width: 180px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.branch-label.detached { color: var(--danger); border-color: var(--danger); }

/* Per-file sections inside the diff viewer. */
.diff-file { border: 1px solid var(--border); border-radius: 6px; margin-bottom: 8px; }
.diff-file > summary {
  cursor: pointer; padding: 5px 8px; font-family: var(--vscode-editor-font-family, monospace);
  font-size: 12px; background: color-mix(in srgb, var(--fg) 5%, transparent);
}
.diff-file-actions { display: flex; gap: 6px; padding: 6px 8px 0; }
.diff-file .diff-patch { margin: 0; border: 0; }

/* Runs in flight, and who is working inside them. */
.active-list { display: flex; flex-direction: column; gap: 8px; margin-bottom: 14px; }
.active-card {
  border: 1px solid var(--border); border-left: 2px solid var(--bremio-accent);
  border-radius: 6px; padding: 8px 10px;
  background: color-mix(in srgb, var(--bremio-accent) 6%, transparent);
}
.active-card.waiting { border-left-color: var(--warn, #d29922); }
.active-head { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-bottom: 4px; }
.active-mode { font-size: 11px; color: var(--muted); }
.active-agents { font-size: 10px; color: var(--muted); }
.active-prompt { font-size: 12px; margin-bottom: 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.active-tasks { list-style: none; margin: 0; padding: 0; }
.active-tasks li { display: flex; align-items: baseline; gap: 6px; font-size: 12px; padding: 1px 0; }
.active-task-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.active-elapsed { flex: 0 0 auto; font-size: 10px; color: var(--muted); font-variant-numeric: tabular-nums; }
.active-idle { font-size: 11px; color: var(--muted); }

/* The lead's plan for a turn. Reporting only — nothing here is clickable. */
.plan-checklist { margin: 0 0 10px; font-size: 12px; }
.plan-checklist > summary { cursor: pointer; color: var(--muted); }
.plan-summary { color: var(--muted); margin: 4px 0 6px; }
.plan-checklist ul { list-style: none; margin: 0; padding: 0; }
.plan-item { display: flex; align-items: baseline; gap: 7px; padding: 2px 0; }
.plan-item.pending .plan-title { color: var(--muted); }
.plan-item.completed .plan-title { text-decoration: line-through; color: var(--muted); }
.plan-mark { flex: 0 0 auto; width: 12px; text-align: center; font-size: 11px; }
.plan-mark.done { color: var(--ok, #3fb950); }
.plan-mark.failed { color: var(--danger); }
.plan-mark.running { color: var(--bremio-accent-hover); }
.plan-mark.pending { color: var(--muted); }
.plan-title { flex: 1; min-width: 0; }
.plan-agent {
  flex: 0 0 auto; font-size: 10px; color: var(--muted);
  border: 1px solid var(--border); border-radius: 3px; padding: 0 4px;
}
.plan-dep { flex: 0 0 auto; font-size: 10px; color: var(--muted); }

/* Prompts waiting behind the running turn. */
.queue { margin-top: 16px; }
.queue-row {
  display: flex; align-items: center; gap: 8px; padding: 5px 8px; margin-top: 4px;
  border: 1px solid var(--border); border-radius: 6px;
  background: color-mix(in srgb, var(--fg) 4%, transparent);
}
.queue-pos {
  flex: 0 0 auto; width: 18px; height: 18px; border-radius: 50%; font-size: 10px;
  display: inline-flex; align-items: center; justify-content: center; color: var(--muted);
  background: color-mix(in srgb, var(--fg) 10%, transparent);
}
.queue-prompt {
  flex: 1; min-width: 0; font-size: 12px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.queue-row button { flex: 0 0 auto; font-size: 11px; padding: 2px 8px; }

/* Attachments: one card each, thumbnail for images, icon otherwise. */
.ctx-cards { display: flex; flex-wrap: wrap; gap: 6px; }
.ctx-card {
  display: inline-flex; align-items: center; gap: 7px; max-width: 260px;
  padding: 4px 6px; border: 1px solid var(--border); border-radius: 6px;
  background: color-mix(in srgb, var(--fg) 4%, transparent);
}
.ctx-card.disabled { opacity: .45; }
.ctx-card-thumb {
  width: 30px; height: 30px; object-fit: cover; border-radius: 4px; flex: 0 0 auto;
  border: 1px solid var(--border); background: color-mix(in srgb, var(--fg) 6%, transparent);
}
.ctx-card-icon { flex: 0 0 auto; width: 30px; text-align: center; color: var(--muted); }
.ctx-card-text { display: flex; flex-direction: column; min-width: 0; line-height: 1.25; }
.ctx-card-name { font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ctx-card-meta { font-size: 10px; color: var(--muted); }
.ctx-card button {
  background: none; border: 0; color: var(--muted); cursor: pointer;
  padding: 0 2px; font-size: 11px; flex: 0 0 auto;
}
.ctx-card button:hover { color: var(--danger); }

/* Diff viewer: syntax-highlighted unified-diff inside the panel. */
.diff-viewer { margin-bottom: 10px; }
.diff-header { margin-bottom: 8px; }
.diff-stat { font-size: 11px; color: var(--text-muted); margin-bottom: 8px; padding: 6px 8px; background: var(--surface-raised); border-radius: 4px; }
.diff-patch { font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; line-height: 1.6; background: var(--vscode-textCodeBlock-background, var(--surface-raised)); border: 1px solid var(--border); border-radius: 6px; padding: 10px; max-height: 480px; overflow: auto; resize: vertical; white-space: pre; margin: 0 0 10px; }
.diff-patch div { min-height: 1em; }
.diff-add { background: rgba(55, 200, 55, 0.12); color: var(--vscode-gitDecoration-addedResourceForeground, #3fb950); }
.diff-remove { background: rgba(200, 55, 55, 0.12); color: var(--vscode-gitDecoration-deletedResourceForeground, #f85149); }
.diff-hunk { color: var(--text-muted); font-weight: 600; }
.diff-meta { color: var(--text-muted); }
</style>
</head>
<body>
<header>
  <img class="logo" src="${iconUri}" alt="">
  <div>
    <div class="wordmark">Bremio</div>
    <div class="tagline">Different minds. One team.</div>
  </div>
  <div class="spacer"></div>
  <div class="row"><span class="branch-label" id="repo-branch" style="display:none"></span><span class="status-dot" id="daemon-dot"></span><span class="muted" id="daemon-status">connecting…</span><button class="ghost" id="reconnect" style="display:none">Reconnect</button></div>
</header>

<nav>
  <button data-tab="run" class="active">Run</button>
  <button data-tab="sessions">Sessions</button>
  <button data-tab="runs">Runs</button>
  <button data-tab="git">Git</button>
  <button data-tab="capacity">Capacity</button>
  <button data-tab="doctor">Doctor</button>
</nav>

<main>
  <section id="tab-run" class="active">
    <div id="run-form">
      <label>Mode</label>
      <div class="seg" id="mode-seg">
        <button data-mode="single" class="on">Single</button>
        <button data-mode="team">Team</button>
        <button data-mode="auto">Auto</button>
      </div>
      <div class="muted" id="auto-note" style="display:none">Bremio picks Single or Team from this repository's calibration evidence, and records why.</div>

      <label id="agent-label">Agent</label>
      <select id="agent"></select>

      <div id="worker-wrap" style="display:none">
        <label>Worker</label>
        <select id="worker"></select>
      </div>

      <div id="concurrency-wrap" style="display:none">
        <label>Concurrency (independent tasks at once)</label>
        <input id="concurrency" type="number" min="1" value="2">
      </div>

      <label>Repository</label>
      <input id="repo" type="text" placeholder="the folder open in VS Code">

      <label>Prompt</label>
      <div class="composer">
        <textarea id="prompt" placeholder="add a health endpoint"></textarea>
        <div id="attachments" class="attachments"></div>
        <div class="composer-actions">
          <button class="ghost icon" id="attach-files" title="Attach files from the workspace">
            <span class="glyph">+</span> Add context
          </button>
          <button class="ghost icon" id="attach-open" title="Attach the file open in the editor">
            Current file
          </button>
          <div class="spacer"></div>
          <button class="primary" id="start">Run</button>
        </div>
      </div>
      <p class="muted hint" id="run-hint"></p>
    </div>

    <div id="run-live" style="display:none">
      <div class="row between" style="margin-bottom:10px">
        <div class="row"><span class="card-title" id="live-title">Running</span><span class="badge ok" id="live-state">running</span></div>
        <div class="row">
          <button class="ghost" id="cancel">Cancel</button>
          <button class="ghost" id="new-run" style="display:none">New run</button>
        </div>
      </div>
      <pre class="log" id="log"></pre>
      <div id="gate"></div>
    </div>
  </section>

  <section id="tab-sessions"><div class="empty">Loading sessions…</div></section>
  <section id="tab-runs"><div id="active-runs"></div><div id="runs-list"><div class="empty">Loading runs…</div></div></section>
  <section id="tab-git"><div class="empty">Loading changes…</div></section>
  <section id="tab-capacity"><div class="empty">Loading capacity…</div></section>
  <section id="tab-doctor"><div class="empty">Checking adapters…</div></section>
</main>

<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);
let mode = "single";
let adapters = [];
let activeRunId = null;

/** Show a tab without asking the host to reload it. */
/**
 * Keep "Working now" current, but only while it is on screen.
 *
 * Elapsed times tick and tasks change, so a single fetch on tab open goes
 * stale within seconds. The interval is cleared the moment another tab is
 * shown: a hidden panel polling a daemon forever is a cost with no reader.
 */
let activePollTimer = null;

function setActivePolling(on) {
  if (activePollTimer) {
    clearInterval(activePollTimer);
    activePollTimer = null;
  }
  if (!on) return;
  activePollTimer = setInterval(() => vscode.postMessage({ type: "refreshActive" }), 2000);
}

function showTab(tab) {
  document.querySelectorAll("nav button").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  document.querySelectorAll("main section").forEach((s) => s.classList.toggle("active", s.id === "tab-" + tab));
  setActivePolling(tab === "runs");
}

document.querySelectorAll("nav button").forEach((button) => {
  button.addEventListener("click", () => {
    const tab = button.dataset.tab;
    showTab(tab);
    vscode.postMessage({ type: "tab", tab });
  });
});

$("mode-seg").addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  mode = button.dataset.mode;
  document.querySelectorAll("#mode-seg button").forEach((b) => b.classList.toggle("on", b === button));
  // Under auto the run may resolve to Team, so the worker and concurrency
  // controls stay available — hiding them would silently discard a choice the
  // resolved mode can still use.
  const teamCapable = mode === "team" || mode === "auto";
  $("agent-label").textContent = teamCapable ? "Lead" : "Agent";
  $("worker-wrap").style.display = teamCapable ? "block" : "none";
  $("concurrency-wrap").style.display = teamCapable ? "block" : "none";
  $("auto-note").style.display = mode === "auto" ? "block" : "none";
  renderAgentOptions();
});

function renderAgentOptions() {
  const agent = $("agent");
  const worker = $("worker");
  agent.innerHTML = "";
  worker.innerHTML = "";
  // Auto can resolve to Team, so its agent must be able to lead. Offering a
  // non-lead-eligible agent would let the user pick something that fails only
  // once the ledger happens to say Team.
  const requiresLead = mode === "team" || mode === "auto";
  for (const a of adapters) {
    // The capability contract decides, so a provider without structured
    // output simply cannot be offered here.
    if (requiresLead && !a.leadEligible) continue;
    const option = document.createElement("option");
    option.value = a.id;
    option.textContent = a.id + (a.health.status === "ok" ? "" : " (" + a.health.status + ")");
    agent.appendChild(option);
  }
  for (const a of adapters) {
    const option = document.createElement("option");
    option.value = a.id;
    option.textContent = a.id;
    worker.appendChild(option);
  }
  $("run-hint").textContent = mode === "auto"
    ? "Auto decides from calibration evidence and falls back to Single until there is enough."
    : mode === "team"
      ? "Lead plans; the worker executes in isolated git worktrees."
      : "One agent works directly in the repository.";
}

$("reconnect").addEventListener("click", () => {
  $("daemon-status").textContent = "reconnecting…";
  vscode.postMessage({ type: "reconnect" });
});

$("attach-files").addEventListener("click", () => vscode.postMessage({ type: "pickFiles" }));
$("attach-open").addEventListener("click", () => vscode.postMessage({ type: "attachActiveFile" }));

$("start").addEventListener("click", () => {
  vscode.postMessage({
    type: "startRun",
    mode,
    agentId: $("agent").value,
    workerId: mode === "single" ? undefined : $("worker").value,
    maxConcurrency: mode === "single" ? undefined : Number($("concurrency").value),
    repoPath: $("repo").value.trim(),
    prompt: $("prompt").value.trim(),
    attachments: attachments.map((file) => file.path),
  });
});

$("cancel").addEventListener("click", () => vscode.postMessage({ type: "cancelRun", id: activeRunId }));
$("new-run").addEventListener("click", () => {
  $("run-form").style.display = "block";
  $("run-live").style.display = "none";
  $("log").textContent = "";
  $("gate").innerHTML = "";
});

function appendLog(event) {
  const view = renderLogLine(event);
  const line = document.createElement("div");
  line.className = "log-line " + (view.severity || "info");

  const tag = event.taskId ? "[" + event.taskId + "] " : "";
  let html = '<span class="log-tag">' + escapeHtml(tag) + '</span>'
    + '<span class="log-summary">' + escapeHtml(view.summary) + '</span>';

  if (view.detail && view.kind !== "message") {
    html += '<pre class="log-detail">' + escapeHtml(view.detail) + '</pre>';
  }

  line.innerHTML = html;
  $("log").appendChild(line);
  $("log").scrollTop = $("log").scrollHeight;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

window.addEventListener("message", (event) => {
  const message = event.data;
  if (message.type === "daemon") {
    $("daemon-dot").className = "status-dot " + (message.live ? "live" : "down");
    $("daemon-status").textContent = message.detail;
    // Without this the only way back from a dead daemon is closing and
    // reopening the panel, because the agent lists are only ever filled from a
    // successful connection — a down daemon leaves Lead and Worker empty with
    // no way to retry in place.
    $("reconnect").style.display = message.live ? "none" : "inline-block";
  }
  if (message.type === "adapters") {
    adapters = message.adapters;
    renderAgentOptions();
    $("tab-doctor").innerHTML = message.adapters.map((a) => \`
      <div class="card">
        <div class="card-head">
          <span class="agent" data-agent="\${escapeHtml(a.id)}"><span class="card-title">\${escapeHtml(a.id)}</span></span>
          <span class="badge \${a.health.status === "ok" ? "ok" : a.health.status === "degraded" ? "warn" : "bad"}">\${escapeHtml(a.health.status)}</span>
          \${a.leadEligible ? '<span class="badge lead">lead</span>' : ""}
        </div>
        <div class="secondary">\${escapeHtml(a.health.detail ?? "")}</div>
        \${a.leadEligible ? "" : '<div class="muted">Not lead-eligible: needs planning + structured output.</div>'}
      </div>\`).join("");
  }
  if (message.type === "capacity") {
    $("tab-capacity").innerHTML = renderCapacityCards(message.capacity);
  }
  if (message.type === "runs") {
    $("runs-list").innerHTML = renderRuns(message.runs);
  }
  if (message.type === "activeRuns") {
    $("active-runs").innerHTML = renderActiveRuns(message.active);
  }
  if (message.type === "gitStatus") {
    $("tab-git").innerHTML = renderGitPanel(message.git);
  }
  if (message.type === "gitResult") {
    const host = $("git-result");
    if (host) {
      host.innerHTML = '<div class="banner ' + (message.ok ? "ok" : "bad") + '">'
        + escapeHtml(message.detail) + "</div>";
    }
  }
  if (message.type === "repoState") {
    const state = message.repoState || {};
    const label = $("repo-branch");
    // Nothing rather than something stale: apply and merge act relative to the
    // checked-out branch, so a wrong label here is worse than an absent one.
    if (state.detached) {
      label.textContent = "detached HEAD";
      label.className = "branch-label detached";
      label.style.display = "";
    } else if (state.branch) {
      label.textContent = state.branch;
      label.className = "branch-label";
      label.style.display = "";
    } else {
      label.textContent = "";
      label.style.display = "none";
    }
  }
  if (message.type === "sessions") {
    $("tab-sessions").innerHTML = renderSessionList(message.sessions, message.groups);
  }
  if (message.type === "sessionDetail") {
    storedContextItems = message.contextItems || [];
    currentSessionId = message.session.id;
    storedQueue = message.queued || [];
    queueHeld = false;
    $("tab-sessions").innerHTML = renderTranscript(message.session, message.turns, storedContextItems, getVisionNotice(), storedQueue, queueHeld);
    annotateThumbDims();
  }
  if (message.type === "queueUpdated" && message.sessionId === currentSessionId) {
    storedQueue = message.queued || [];
    if (typeof message.held === "boolean") queueHeld = message.held;
    const section = $("tab-sessions").querySelector("#queue-section");
    const rendered = renderQueue(currentSessionId, storedQueue, queueHeld);
    if (section) {
      // outerHTML, not replaceWith(string) — the latter inserts a text node.
      if (rendered) section.outerHTML = rendered;
      else section.remove();
    } else if (rendered) {
      const ctx = $("tab-sessions").querySelector("#context-items-section");
      if (ctx) ctx.insertAdjacentHTML("beforebegin", rendered);
    }
  }
  if (message.type === "contextItemsUpdated") {
    storedContextItems = message.contextItems || [];
    const transcript = $("tab-sessions").querySelector("#continue-wrap");
    if (transcript) {
      const ctxSection = $("tab-sessions").querySelector("#context-items-section");
      // replaceWith(string) inserts a *text node*: the markup was displayed as
      // literal source, and the real section — with the Add File / Add Image /
      // Add Current File buttons — was replaced by that text, so after adding
      // one item you could not add another. outerHTML parses it as markup.
      if (ctxSection) {
        ctxSection.outerHTML = renderContextItems(currentSessionId, storedContextItems, getVisionNotice());
        annotateThumbDims();
      }
    }
  }
  if (message.type === "runStarted") {
    activeRunId = message.id;
    $("run-form").style.display = "none";
    $("run-live").style.display = "block";
    $("log").textContent = "";
    $("gate").innerHTML = "";
    $("live-state").textContent = "running";
    $("live-state").className = "badge ok";
    $("cancel").style.display = "inline-block";
    $("new-run").style.display = "none";
  }
  if (message.type === "workspace" && message.repoPath && !$("repo").value) {
    $("repo").value = message.repoPath;
  }
  if (message.type === "attachments") addAttachments(message.files);
  if (message.type === "runEvent") appendLog(message.event);
  if (message.type === "streamReconnecting") {
    appendLog({ kind: "status", message: "connection dropped — resuming from event " + message.seq });
  }
  if (message.type === "runFinished") {
    $("live-state").textContent = message.state;
    $("live-state").className = "badge " + (message.state === "completed" ? "ok" : message.state === "cancelled" || message.state === "interrupted" ? "warn" : "bad");
    $("cancel").style.display = "none";
    $("new-run").style.display = "inline-block";
    let panelHtmlOut = "";
    if (message.state === "interrupted") {
      panelHtmlOut += '<div class="banner warn">The daemon restarted while this run was in flight, so it was never judged. Retry starts a new run and keeps this history.</div>';
    } else if (message.failureMessage) {
      panelHtmlOut += '<div class="banner bad">' + escapeHtml(message.failureMessage) + "</div>";
    }
    panelHtmlOut += renderDecisionReasons(message);
    if (message.gate) panelHtmlOut += renderGate(message.gate, message.runId);
    if (message.recovery?.canRetry) {
      panelHtmlOut += '<div class="row" style="margin-top:10px"><button class="ghost" data-action="retry" data-run="' + escapeHtml(message.runId) + '">Retry</button></div>';
    }
    $("gate").innerHTML = panelHtmlOut;
  }
  if (message.type === "error") {
    // Protocol problems are not transient, so they are stated as their own
    // thing rather than looking like the daemon merely being offline.
    const cls = message.kind === "protocol" ? "warn" : "bad";
    $("gate").innerHTML = '<div class="banner ' + cls + '">' + escapeHtml(message.message) + "</div>";
  }
  if (message.type === "mergeResult") {
    const cls = message.ok ? "warn" : "bad";
    $("gate").insertAdjacentHTML("beforeend",
      '<div class="banner ' + cls + '">' + escapeHtml(message.detail) + "</div>");
  }
  if (message.type === "showDiff") {
    $("gate").innerHTML = renderDiffViewer(message.diff);
  }
  if (message.type === "applyResult" || message.type === "revertResult") {
    const verb = message.type === "applyResult" ? "apply" : "revert";
    let html = '<div class="banner ' + (message.ok ? "ok" : "bad") + '">' + escapeHtml(message.detail) + "</div>";
    // Where --force put the user's overwritten edits. The CLI has printed this
    // since the S5 review; the panel dropped it, and the panel is the surface
    // where force is one click away.
    if (message.recoveryPatch) {
      html += '<div class="banner warn">Your overwritten changes were saved to '
        + escapeHtml(message.recoveryPatch)
        + " — restore them with: git apply " + escapeHtml(message.recoveryPatch) + "</div>";
    }
    if (message.conflictedFiles && message.conflictedFiles.length > 0) {
      html += '<div class="card" style="margin-top:8px"><span class="card-title">Conflicting files</span>';
      for (const cf of message.conflictedFiles) {
        const label = cf.status === "user_modified" ? "modified by you" : cf.status === "user_deleted" ? "deleted by you" : cf.status;
        html += '<div class="row muted" style="font-size:11px">- ' + escapeHtml(cf.file) + ' (' + label + ')</div>';
      }
      // Carry the file through. Without it, overwriting after a *per-file*
      // conflict would force the whole run — escalating a one-file action into
      // every file, which is the opposite of what the user asked for.
      const fileAttr = message.filePath
        ? ' data-file="' + escapeHtml(message.filePath) + '"'
        : "";
      const scope = message.filePath ? escapeHtml(message.filePath) : "all files";
      html += '<div class="row" style="margin-top:8px">'
        + '<button class="ghost" data-action="force-' + verb + '-diff"' + fileAttr + '>'
        + "Overwrite &amp; " + verb + " " + scope + "</button>"
        + '</div></div>';
    }
    $("gate").insertAdjacentHTML("beforeend", html);
  }
});

function renderGate(gate, runId) {
  if (gate.status !== "passed") {
    return '<div class="banner warn"><strong>Quality gate: ' + escapeHtml(gate.status) + "</strong><br>"
      + gate.reasons.map(escapeHtml).join("<br>")
      + "<br>Merging stays blocked until the gate passes.</div>";
  }
  return '<div class="card"><div class="card-head"><span class="card-title">Quality gate passed</span>'
    + '<span class="badge ok">ready</span></div>'
    + '<div class="secondary">Review the diff, then apply, revert or merge changes.</div>'
    + '<div class="row" style="margin-top:10px">'
    + '<button class="ghost" data-action="diff" data-run="' + escapeHtml(runId) + '">View diff</button>'
    + '<button class="ghost" data-action="apply-diff">Apply</button>'
    + '<button class="ghost" data-action="revert-diff">Revert</button>'
    + '<div class="spacer"></div>'
    + '<button class="primary" data-action="merge" data-run="' + escapeHtml(runId) + '">Merge</button>'
    + "</div></div>";
}

// Inlined from webview.ts so the panel and the unit test share one renderer.
// Bound to a fixed name here regardless of how the source function is compiled.
const renderCapacityCards = ${renderCapacityCards.toString()};

// Same single-source-of-truth inlining: the panel and the unit test run this
// exact function, so a test cannot pass while the branch is disabled.
const renderDecisionReasons = ${renderDecisionReasons.toString()};

// Inlined from webview.ts so the panel and the unit test share one renderer.
// Canonical source: packages/event-view/src/index.ts.
const renderEvent = ${renderEvent.toString()};
const formatTaskExecution = ${formatTaskExecution.toString()};
const renderLogLine = ${renderLogLine.toString()};
const assembleTaskLanes = ${assembleTaskLanes.toString()};
const extractResponse = ${extractResponse.toString()};
const renderDiffViewer = ${renderDiffViewer.toString()};

function renderSessionList(sessions, groups) {
  const badge = (status) =>
    status === "completed" ? "ok" : status === "failed" ? "bad" : "warn";

  if (groups && groups.length > 0) {
    return groups.map((g) => {
      const header = '<div class="section-label" style="margin-top:12px;margin-bottom:6px;display:flex;align-items:center;gap:6px">'
        + '<span style="font-weight:600;color:var(--fg)">' + escapeHtml(g.projectName) + "</span>"
        + '<span class="muted" style="font-size:10px">(' + escapeHtml(g.repositoryPath) + ")</span>"
        + "</div>";

      const rows = (g.sessions || []).map((s) => {
        const turns = s.turnCount ?? 1;
        return '<div class="session-row" data-session="' + escapeHtml(s.id) + '">'
          + '<span class="title">' + escapeHtml(s.title || "Untitled") + "</span>"
          + '<span class="muted">' + turns + (turns === 1 ? " turn" : " turns") + "</span>"
          + '<span class="badge ' + badge(s.status) + '">' + escapeHtml(s.status ?? "completed") + "</span>"
          + "</div>";
      }).join("");

      return header + (rows || '<div class="empty">No sessions in this project.</div>');
    }).join("");
  }

  if (!sessions || sessions.length === 0) {
    return '<div class="empty">No sessions in this repository yet.</div>';
  }

  return sessions.map((s) => {
    const turns = s.turnCount ?? 1;
    return '<div class="session-row" data-session="' + escapeHtml(s.id) + '">'
      + '<span class="title">' + escapeHtml(s.title || "Untitled") + "</span>"
      + '<span class="muted">' + turns + (turns === 1 ? " turn" : " turns") + "</span>"
      + '<span class="badge ' + badge(s.status) + '">' + escapeHtml(s.status ?? "completed") + "</span>"
      + "</div>";
  }).join("");
}

/**
 * Label each thumbnail with its pixel size once the browser has decoded it.
 *
 * Done here rather than in the markup because the CSP has no 'unsafe-inline',
 * so an onload attribute would never fire — and because the extension would
 * otherwise have to parse PNG/JPEG headers to learn something the image
 * element already knows.
 */
function annotateThumbDims() {
  const imgs = document.querySelectorAll("#context-items-section img[data-dims]");
  for (const img of imgs) {
    if (img.dataset.dimsDone) continue;
    const fill = function() {
      if (img.dataset.dimsDone || !img.naturalWidth) return;
      img.dataset.dimsDone = "1";
      const meta = img.parentElement ? img.parentElement.querySelector(".ctx-card-meta") : null;
      if (!meta) return;
      const dims = img.naturalWidth + "\\u00d7" + img.naturalHeight;
      meta.textContent = meta.textContent ? dims + " \\u00b7 " + meta.textContent : dims;
    };
    if (img.complete) fill();
    else img.addEventListener("load", fill, { once: true });
  }
}

/**
 * Staged and unstaged changes, with commit (S10-T10).
 *
 * Every file carries its own checkbox and the buttons act on the checked set,
 * because the one rule this feature must not break is that Bremio stages what
 * the user chose and nothing else — docs/15 §2.4.1, and the S5 review that
 * removed an add-everything call for flattening a partially staged index.
 */
function renderGitPanel(git) {
  if (!git) return '<div class="empty">Loading changes…</div>';
  if (git.error) return '<div class="banner bad">' + escapeHtml(git.error) + "</div>";

  const entries = git.entries || [];
  const staged = entries.filter(function(e) { return e.staged; });
  const unstaged = entries.filter(function(e) { return !e.staged; });

  const row = (entry, idx) => '<label class="git-row">'
    + '<input type="checkbox" data-git-path="' + escapeHtml(entry.path) + '" id="git-' + (entry.staged ? "s" : "u") + idx + '">'
    + '<span class="git-status ' + escapeHtml(entry.status) + '">' + escapeHtml(entry.status) + "</span>"
    + '<span class="git-path">' + escapeHtml(entry.path) + "</span>"
    + "</label>";

  const section = (title, list, action, label) => {
    if (list.length === 0) {
      return '<div class="section-label">' + title + '</div><div class="secondary">Nothing ' + (action === "stage" ? "to stage" : "staged") + ".</div>";
    }
    return '<div class="section-label">' + title + " (" + list.length + ")</div>"
      + '<div class="git-list" data-git-group="' + action + '">' + list.map(row).join("") + "</div>"
      + '<div class="row" style="margin:6px 0 12px">'
      + '<button class="ghost" data-action="git-' + action + '">' + label + "</button>"
      + '<button class="ghost" data-action="git-select-all" data-group="' + action + '">Select all</button>'
      + "</div>";
  };

  const branches = git.branches || [];
  const options = branches
    .map(function(b) {
      return '<option value="' + escapeHtml(b.name) + '"' + (b.current ? " selected" : "") + ">"
        + escapeHtml(b.name) + "</option>";
    })
    .join("");
  const branchBar = branches.length > 0
    ? '<div class="section-label">Branch</div>'
      + '<div class="row" style="margin-bottom:12px">'
      + '<select id="git-branch-select">' + options + "</select>"
      + '<button class="ghost" data-action="git-switch">Switch</button>'
      + '<input id="git-branch-new" type="text" placeholder="new branch name">'
      + '<button class="ghost" data-action="git-create-branch">Create</button>'
      + "</div>"
    : "";

  return '<div class="row" style="margin-bottom:10px">'
    + '<span class="section-label">Changes on ' + escapeHtml(git.branch || (git.detached ? "detached HEAD" : "?")) + "</span>"
    + '<div class="spacer"></div>'
    + '<button class="ghost" data-action="git-refresh">Refresh</button>'
    + "</div>"
    + branchBar
    + section("Staged", staged, "unstage", "Unstage selected")
    + section("Changes", unstaged, "stage", "Stage selected")
    + '<div class="section-label">Commit & Sync</div>'
    + '<textarea id="git-message" rows="3" placeholder="commit message"></textarea>'
    + '<div class="row" style="margin-top:8px">'
    + '<button class="primary" data-action="git-commit">Commit staged</button>'
    + '<button class="ghost" data-action="git-pull">Pull</button>'
    + '<button class="ghost" data-action="git-push">Push</button>'
    + "</div>"
    + '<details style="margin-top:14px"><summary style="cursor:pointer;font-size:12px;color:var(--text-muted);font-weight:600">Open Pull Request via gh</summary>'
    + '<input id="git-pr-title" type="text" placeholder="pull request title" style="margin-top:6px">'
    + '<textarea id="git-pr-body" rows="2" placeholder="description (optional)" style="margin-top:6px"></textarea>'
    + '<div class="row" style="margin-top:6px;align-items:center">'
    + '<label style="display:inline-flex;align-items:center;gap:4px;font-size:11px;cursor:pointer;margin:0"><input type="checkbox" id="git-pr-draft" style="width:auto"> Draft</label>'
    + '<div class="spacer"></div>'
    + '<button class="ghost" data-action="git-create-pr">Create PR</button>'
    + "</div>"
    + "</details>"
    + '<div id="git-result"></div>';
}

/**
 * Who is working right now (S10-T4).
 *
 * The panel could previously only say how many runs were active. That is not
 * enough to read a Co-lab run: two workers with a task each, and one of them
 * running far longer than the other, is the thing worth seeing — and a run
 * started from a different window was invisible entirely.
 */
function renderActiveRuns(active) {
  if (!active || active.length === 0) return "";

  const elapsed = (since) => {
    const seconds = Math.max(0, Math.round((Date.now() - since) / 1000));
    if (seconds < 60) return seconds + "s";
    const minutes = Math.floor(seconds / 60);
    return minutes < 60 ? minutes + "m" : Math.floor(minutes / 60) + "h" + (minutes % 60) + "m";
  };

  const cards = active.map(function(run) {
    // A run blocked on a human is active but not working. Saying so is the
    // difference between "still going" and "waiting for you".
    const waiting = run.status === "pending_approval";
    const workers = (run.workerProviders || []).length > 0
      ? '<span class="active-agents">' + (run.workerProviders || []).map(escapeHtml).join(", ") + "</span>"
      : "";
    const tasks = (run.tasksInFlight || []).length > 0
      ? '<ul class="active-tasks">' + run.tasksInFlight.map(function(task) {
          return "<li>"
            + '<span class="active-task-title">' + escapeHtml(task.title) + "</span>"
            + (task.agentId ? '<span class="plan-agent">' + escapeHtml(task.agentId) + "</span>" : "")
            + '<span class="active-elapsed">' + escapeHtml(elapsed(task.since)) + "</span>"
            + "</li>";
        }).join("") + "</ul>"
      : '<div class="active-idle">'
        + (waiting ? "waiting for your review" : "no task started yet")
        + "</div>";

    return '<div class="active-card' + (waiting ? " waiting" : "") + '">'
      + '<div class="active-head">'
      + '<span class="badge ' + (waiting ? "warn" : "ok") + '">' + escapeHtml(waiting ? "review" : "running") + "</span>"
      + '<span class="active-mode">' + escapeHtml(displayMode(run.mode)) + "</span>"
      + (run.leadProvider ? '<span class="plan-agent">' + escapeHtml(run.leadProvider) + " · lead</span>" : "")
      + workers
      + "</div>"
      + '<div class="active-prompt">' + escapeHtml((run.prompt || "").slice(0, 140)) + "</div>"
      + tasks
      + "</div>";
  }).join("");

  return '<div class="section-label" style="margin-bottom:6px">'
    + '<span class="codicon codicon-pulse"></span> Working now (' + active.length + ")</div>"
    + '<div class="active-list">' + cards + "</div>";
}

/**
 * The lead's plan for one turn, as a checklist (S10-T3).
 *
 * Deliberately not interactive. These are the agent's items, and a checkbox the
 * user can tick would claim they can change what the agent is doing — they
 * cannot. The glyphs report; they do not offer.
 */
function renderPlanChecklist(plan) {
  if (!plan || !plan.tasks || plan.tasks.length === 0) return "";
  const glyph = {
    completed: '<span class="plan-mark done">\\u2713</span>',
    failed: '<span class="plan-mark failed">\\u2717</span>',
    running: '<span class="plan-mark running">\\u25cf</span>',
    pending: '<span class="plan-mark pending">\\u25cb</span>',
  };
  const done = plan.tasks.filter(function(t) { return t.status === "completed"; }).length;
  const rows = plan.tasks.map(function(task) {
    const waiting = task.status === "pending" && task.dependsOn && task.dependsOn.length > 0
      ? '<span class="plan-dep">after ' + escapeHtml(task.dependsOn.join(", ")) + '</span>'
      : "";
    return '<li class="plan-item ' + escapeHtml(task.status) + '">'
      + (glyph[task.status] || glyph.pending)
      + '<span class="plan-title">' + escapeHtml(task.title) + '</span>'
      + (task.agentId ? '<span class="plan-agent">' + escapeHtml(task.agentId) + '</span>' : "")
      + waiting
      + '</li>';
  }).join("");
  return '<details class="plan-checklist" open>'
    + '<summary>Plan · ' + done + '/' + plan.tasks.length + ' done</summary>'
    + (plan.summary ? '<div class="plan-summary">' + escapeHtml(plan.summary) + '</div>' : "")
    + '<ul>' + rows + '</ul>'
    + '</details>';
}

/**
 * Prompts waiting behind the running turn (S10-T2).
 *
 * Held prompts get a Run button as well as Remove: the queue does not advance
 * on its own after a turn that was cancelled or failed, so without it a user
 * who cancelled would have no way forward except retyping.
 */
function renderQueue(sessionId, queued, held) {
  if (!queued || queued.length === 0) return "";
  const sid = escapeHtml(sessionId);
  const rows = queued.map(function(item, idx) {
    const first = idx === 0;
    return '<div class="queue-row">'
      + '<span class="queue-pos">' + (idx + 1) + '</span>'
      + '<span class="queue-prompt">' + escapeHtml(item.prompt || "") + '</span>'
      + (held && first
        ? '<button class="ghost" data-queue-release="' + escapeHtml(item.id) + '" data-session="' + sid + '">Run</button>'
        : '')
      + '<button class="ghost" data-queue-remove="' + escapeHtml(item.id) + '" data-session="' + sid + '">Remove</button>'
      + '</div>';
  }).join("");
  return '<div id="queue-section" class="queue">'
    + '<div class="section-label"><span class="codicon codicon-list-ordered"></span> Queued ('
    + queued.length + ')</div>'
    + (held
      ? '<div class="banner warn" style="font-size:12px">The previous turn did not complete, so these are waiting for you rather than running on their own.</div>'
      : '<div class="secondary" style="font-size:12px">These run in order when the current turn finishes.</div>')
    + rows
    + '</div>';
}

function renderContextItems(sessionId, items, visionNotice) {
  const sid = escapeHtml(sessionId);
  const notice = visionNotice ? '<div class="banner warn" style="margin-bottom:6px;font-size:12px">' + escapeHtml(visionNotice) + '</div>' : "";
  const hasTokens = items && items.some((i) => i.tokensEstimated !== undefined);
  const totalTokens = hasTokens
    ? items.filter((i) => i.enabled).reduce((s, i) => s + (i.tokensEstimated ?? 0), 0)
    : 0;
  const tokenSummary = hasTokens
    ? '<span class="muted" style="font-size:11px">' + totalTokens + 't · estimated</span>'
    : "";
  if (!items || items.length === 0) {
    return '<div id="context-items-section" style="margin-top:16px">'
      + '<div class="section-label" style="margin-bottom:6px"><span class="codicon codicon-pin"></span> Context Items</div>'
      + '<div class="secondary" style="margin-bottom:8px">No context items for this session.</div>'
      + notice
      + '<button class="ghost" data-context-add data-session="' + sid + '">Add File</button>'
      + '<button class="ghost" data-context-image data-session="' + sid + '">Add Image</button>'
      + '<button class="ghost" data-context-file data-session="' + sid + '">Add Current File</button>'
      + '<button class="ghost" data-compact-session="' + sid + '" style="margin-left:4px">Compact</button>'
      + '</div>';
  }
  // One card per attachment: a thumbnail for an image, a file icon otherwise,
  // then the filename. This was a chip row plus a separate thumbnail gallery,
  // which showed each image twice and pushed the buttons down the panel.
  const cards = items.map(function(item, idx) {
    const isImage = item.type === "image";
    const name = escapeHtml(item.source.slice(Math.max(item.source.lastIndexOf("/"), item.source.lastIndexOf("\\\\")) + 1));
    const figure = isImage && item.preview
      ? '<img class="ctx-card-thumb" src="' + escapeHtml(item.preview) + '" alt="' + name + '" loading="lazy" data-dims>'
      : '<span class="ctx-card-icon codicon codicon-' + (isImage ? 'file-media' : 'file') + '"></span>';
    const meta = item.tokensEstimated !== undefined ? item.tokensEstimated + "t" : "";
    return '<span class="ctx-card' + (item.enabled ? '' : ' disabled') + '" title="' + escapeHtml(item.source) + '">'
      + figure
      + '<span class="ctx-card-text">'
      + '<span class="ctx-card-name">' + name + '</span>'
      + '<span class="ctx-card-meta">' + escapeHtml(meta) + '</span>'
      + '</span>'
      + '<button data-context-toggle="' + idx + '" data-item="' + escapeHtml(item.id) + '" data-enabled="' + (item.enabled ? '1' : '0') + '" aria-label="Toggle">' + (item.enabled ? '●' : '○') + '</button>'
      + '<button data-context-remove="' + idx + '" data-item="' + escapeHtml(item.id) + '" aria-label="Remove">x</button>'
      + '</span>';
  }).join("");
  return '<div id="context-items-section" style="margin-top:16px">'
    + '<div class="section-label" style="margin-bottom:6px"><span class="codicon codicon-pin"></span> Context Items (' + items.length + ')' + tokenSummary + '</div>'
    + notice
    + '<div class="ctx-cards">' + cards + '</div>'
    + '<div style="margin-top:8px">'
    + '<button class="ghost" data-context-add data-session="' + sid + '">Add File</button>'
    + '<button class="ghost" data-context-image data-session="' + sid + '">Add Image</button>'
    + '<button class="ghost" data-context-file data-session="' + sid + '">Add Current File</button>'
    + '<button class="ghost" data-compact-session="' + sid + '" style="margin-left:4px">Compact</button>'
    + '</div></div>';
}

/**
 * Render an agent reply as Markdown.
 *
 * Escaping happens first, on the raw text, so by the time any pattern runs
 * there is no left angle bracket or ampersand left to smuggle a tag through —
 * every element below is one this function wrote. Do not reorder that.
 *
 * Deliberately small: paragraphs, headings, lists, fenced and inline code,
 * bold/italic, links, rules, blockquotes. Anything else falls through as
 * text, which is what the whole reply used to be.
 */
function renderMarkdown(text) {
  if (!text) return "";

  // Pull fenced blocks out before anything else touches them, so their
  // contents are never treated as markup.
  const fences = [];
  let src = escapeHtml(String(text)).replace(/\`\`\`([\\w-]*)\\n?([\\s\\S]*?)\`\`\`/g, function(_m, lang, body) {
    fences.push('<pre><code' + (lang ? ' data-lang="' + lang + '"' : '') + '>' + body.replace(/\\n$/, "") + '</code></pre>');
    return "\\u0000FENCE" + (fences.length - 1) + "\\u0000";
  });

  const inline = (s) => s
    .replace(/\`([^\`]+)\`/g, "<code>$1</code>")
    .replace(/\\*\\*([^*]+)\\*\\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\\*([^*\\n]+)\\*/g, "$1<em>$2</em>")
    // Only http(s): a link is the one place an escaped string could still
    // carry a scheme like javascript:.
    .replace(/\\[([^\\]]+)\\]\\((https?:\\/\\/[^)\\s]+)\\)/g, '<a href="$2">$1</a>');

  const blocks = [];
  let list = null;

  const closeList = () => {
    if (!list) return;
    blocks.push("<" + list.tag + ">" + list.items.join("") + "</" + list.tag + ">");
    list = null;
  };

  for (const rawLine of src.split("\\n")) {
    const line = rawLine.replace(/\\s+$/, "");

    const fence = /^\\u0000FENCE(\\d+)\\u0000$/.exec(line.trim());
    if (fence) { closeList(); blocks.push(fences[Number(fence[1])]); continue; }

    if (line.trim() === "") { closeList(); continue; }

    const heading = /^(#{1,3})\\s+(.*)$/.exec(line);
    if (heading) {
      closeList();
      const level = heading[1].length;
      blocks.push("<h" + level + ">" + inline(heading[2]) + "</h" + level + ">");
      continue;
    }

    if (/^(-{3,}|\\*{3,})$/.test(line.trim())) { closeList(); blocks.push("<hr>"); continue; }

    const quote = /^&gt;\\s?(.*)$/.exec(line);
    if (quote) { closeList(); blocks.push("<blockquote>" + inline(quote[1]) + "</blockquote>"); continue; }

    const bullet = /^\\s*[-*+]\\s+(.*)$/.exec(line);
    const numbered = /^\\s*\\d+[.)]\\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      const tag = bullet ? "ul" : "ol";
      if (!list || list.tag !== tag) { closeList(); list = { tag, items: [] }; }
      list.items.push("<li>" + inline((bullet || numbered)[1]) + "</li>");
      continue;
    }

    closeList();
    blocks.push("<p>" + inline(line) + "</p>");
  }
  closeList();

  return blocks.join("");
}

/**
 * A JSON reply, pretty-printed.
 *
 * Some agents answer with a bare JSON object. As one line it is unreadable —
 * the report that prompted this fix was a single 4,000-character line.
 */
function prettyJsonBlock(text) {
  const trimmed = String(text ?? "").trim();
  if (!(trimmed.startsWith("{") || trimmed.startsWith("[")) || trimmed.length < 40) return "";
  try {
    return "<pre><code>" + escapeHtml(JSON.stringify(JSON.parse(trimmed), null, 2)) + "</code></pre>";
  } catch {
    return "";
  }
}

function renderResponseBody(text) {
  return prettyJsonBlock(text) || renderMarkdown(text);
}

/**
 * A session as a conversation: each turn is the user's prompt, then what the
 * agent did (collapsed), then what it actually said.
 *
 * The response is the point. It is rendered undimmed at full width, because a
 * run whose whole value was the reply used to show only "completed · 0 files".
 */
function renderTranscript(session, turns, contextItems, visionNotice, queued, queueHeld) {
  let out = '<div class="row" style="margin-bottom:10px">'
    + '<button class="ghost" data-action="back-to-sessions">← Sessions</button>'
    + '<strong style="margin-left:8px">' + escapeHtml(session.title || session.id) + "</strong>"
    + "</div>";

  for (const turn of turns) {
    out += '<div class="turn">';
    out += '<div class="speaker you">You</div>';
    out += '<div class="bubble prompt">' + escapeHtml(turn.prompt) + "</div>";

    const who = turn.model || "Agent";
    out += '<div class="speaker agent">' + escapeHtml(who)
      + (turn.reasoningLevel ? ' <span class="muted">· ' + escapeHtml(turn.reasoningLevel) + "</span>" : "")
      + "</div>";

    out += renderPlanChecklist(turn.plan);

    const steps = (turn.events || [])
      .filter((ev) => ev.kind !== "message" && ev.kind !== "completed");
    if (steps.length > 0) {
      out += '<details class="process"><summary>' + steps.length + " step"
        + (steps.length === 1 ? "" : "s") + "</summary>";
      for (const step of steps) {
        out += "<div>" + escapeHtml(step.summary) + "</div>";
      }
      out += "</details>";
    }

    if (turn.inspection) {
      const insp = turn.inspection;
      const filesCount = (insp.filesChanged || []).length;
      const cmdsCount = (insp.commandsRun || []).length;
      if (insp.worktreePath || filesCount > 0 || cmdsCount > 0) {
        out += '<details class="process" style="margin-bottom:8px">'
          + '<summary>Inspect turn (' + filesCount + ' file' + (filesCount === 1 ? '' : 's') + ', ' + cmdsCount + ' cmd' + (cmdsCount === 1 ? '' : 's') + ')</summary>'
          + '<div style="padding:4px 0">';
        if (insp.worktreePath) {
          out += '<div><strong>Worktree:</strong> <code>' + escapeHtml(insp.worktreePath) + '</code></div>';
        }
        if (filesCount > 0) {
          out += '<div style="margin-top:3px"><strong>Files:</strong> ' + insp.filesChanged.map(function(f) { return '<code>' + escapeHtml(f) + '</code>'; }).join(', ') + '</div>';
        }
        if (cmdsCount > 0) {
          out += '<div style="margin-top:3px"><strong>Commands:</strong><ul style="margin:2px 0 0 16px;padding:0">' + insp.commandsRun.map(function(c) { return '<li><code>' + escapeHtml(c) + '</code></li>'; }).join('') + '</ul></div>';
        }
        out += '<div style="margin-top:6px"><button class="ghost" data-action="diff" data-run="' + escapeHtml(turn.runId) + '">View turn diff</button></div>';
        out += '</div></details>';
      }
    }

    out += turn.response
      ? '<div class="bubble response md">' + renderResponseBody(turn.response) + "</div>"
      : '<div class="bubble muted">(no response recorded)</div>';

    out += '<div class="turn-foot">' + escapeHtml(turn.status) + " · run " + escapeHtml(turn.runId) + "</div>";
    out += "</div>";
  }

  out += renderQueue(session.id, queued, queueHeld);
  out += renderContextItems(session.id, contextItems, visionNotice);

  // Continuing a session is the same action as starting a run, aimed at an
  // existing session id — the daemon appends it as the next turn.
  out += '<div id="continue-wrap">'
    + '<label>Continue this session</label>'
    + '<textarea id="continue-prompt" rows="3" placeholder="follow up…"></textarea>'
    + '<div class="row" style="margin-top:8px">'
    + '<button class="primary" data-action="continue-session" data-session="'
    + escapeHtml(session.id) + '">Send turn</button>'
    + "</div></div>";

  return out;
}

function displayMode(mode) {
  return mode === "team" ? "Co-lab" : mode === "single" ? "Solo" : mode;
}

function renderRuns(payload) {
  const runs = payload.runs ?? [];
  const legacy = payload.legacyReports ?? [];
  if (runs.length === 0 && legacy.length === 0) return '<div class="empty">No runs yet.</div>';

  const badge = (status) =>
    status === "completed" ? "ok"
    : status === "running" || status === "queued" ? "warn"
    : status === "interrupted" ? "warn"
    : "bad";

  const cards = runs.map((run) => {
    const interrupted = run.status === "interrupted";
    return \`<div class="card">
      <div class="card-head">
        <span class="card-title">\${escapeHtml(run.id)}</span>
        <span class="badge \${badge(run.status)}">\${escapeHtml(run.status)}</span>
        \${run.retryOfRunId ? '<span class="badge ok">retry</span>' : ""}
        <div class="spacer"></div>
        <span class="agent" data-agent="\${escapeHtml(run.leadProvider ?? "")}">
          <span class="muted">\${escapeHtml(displayMode(run.mode))}</span></span>
      </div>
      <div class="secondary">\${escapeHtml((run.prompt ?? "").slice(0, 160))}</div>
      \${interrupted ? '<div class="muted">The daemon restarted while this run was in flight. Its work was not judged.</div>' : ""}
      \${run.failureMessage && !interrupted ? '<div class="muted">' + escapeHtml(run.failureMessage) + "</div>" : ""}
      <div class="row" style="margin-top:8px">
        <button class="ghost" data-action="open" data-run="\${escapeHtml(run.id)}">Open</button>
        \${isTerminalStatus(run.status) ? '<button class="ghost" data-action="retry" data-run="' + escapeHtml(run.id) + '">Retry</button>' : ""}
      </div>
    </div>\`;
  }).join("");

  const legacyCards = legacy.length === 0 ? "" :
    '<div class="muted" style="margin:12px 0 6px">Runs from before durable history</div>' +
    legacy.map((entry) => \`<div class="card">
      <div class="card-head"><span class="card-title">\${escapeHtml(entry.runId)}</span>
      <span class="badge warn">legacy</span></div>
      <div class="secondary">\${escapeHtml((entry.report?.prompt ?? "").slice(0, 160))}</div>
    </div>\`).join("");

  return cards + legacyCards;
}

function isTerminalStatus(status) {
  return ["completed", "failed", "cancelled", "interrupted"].includes(status);
}

// One delegated listener instead of inline onclick handlers: building
// JavaScript by concatenating strings into an attribute is how quoting bugs
// get shipped, and data attributes make the id impossible to mis-escape.
/*
 * Attached files are sent as paths, not contents.
 *
 * Every adapter can already read files it is told about, so a path works for
 * all of them — including images for providers that can open them. Inlining
 * contents would blow up the prompt and would still not help a provider that
 * cannot read the format.
 */
let attachments = [];
let storedContextItems = [];
let storedQueue = [];
/** True when the queue is waiting on the user because a turn did not complete. */
let queueHeld = false;
let currentSessionId = null;

function getVisionNotice() {
  const hasImageItems = (storedContextItems || []).some((item) => item.type === "image");
  if (!hasImageItems) return "";
  // Derived from the capabilities the daemon reports, not asserted. This
  // returned the "no provider supports vision" string unconditionally, which
  // happens to be true of every adapter today and becomes a false claim the
  // moment one is not.
  if (!adapters || adapters.length === 0) return "";
  const visionCapable = adapters.filter((a) => a.capabilities && a.capabilities.vision);
  if (visionCapable.length > 0) return "";
  return "No installed provider supports vision. Image files will be listed as references, not displayed.";
}

function renderAttachments() {
  const host = $("attachments");
  host.innerHTML = attachments
    .map((file, index) =>
      '<span class="chip" title="' + escapeHtml(file.path) + '">' +
      '<span class="name">' + escapeHtml(file.label) + "</span>" +
      '<button data-drop="' + index + '" aria-label="Remove">x</button></span>')
    .join("");
}

function addAttachments(files) {
  for (const file of files ?? []) {
    if (!attachments.some((existing) => existing.path === file.path)) attachments.push(file);
  }
  renderAttachments();
}

document.addEventListener("click", (event) => {
  const drop = event.target.closest("[data-drop]");
  if (drop) {
    attachments.splice(Number(drop.dataset.drop), 1);
    renderAttachments();
    return;
  }
  const contextAdd = event.target.closest("[data-context-add]");
  if (contextAdd) {
    vscode.postMessage({ type: "addContextItem", sessionId: contextAdd.dataset.session, type: "file", source: "" });
    return;
  }
  const contextFile = event.target.closest("[data-context-file]");
  if (contextFile) {
    vscode.postMessage({ type: "addContextFile", sessionId: contextFile.dataset.session });
    return;
  }
  const queueRemove = event.target.closest("[data-queue-remove]");
  if (queueRemove) {
    vscode.postMessage({ type: "removeQueued", sessionId: queueRemove.dataset.session, runId: queueRemove.dataset.queueRemove });
    return;
  }
  const queueRelease = event.target.closest("[data-queue-release]");
  if (queueRelease) {
    vscode.postMessage({ type: "releaseQueued", sessionId: queueRelease.dataset.session, runId: queueRelease.dataset.queueRelease });
    return;
  }
  const contextToggle = event.target.closest("[data-context-toggle]");
  if (contextToggle) {
    vscode.postMessage({ type: "toggleContextItem", sessionId: currentSessionId, itemId: contextToggle.dataset.item, enabled: contextToggle.dataset.enabled !== "1" });
    return;
  }
  const contextRemove = event.target.closest("[data-context-remove]");
  if (contextRemove) {
    vscode.postMessage({ type: "removeContextItem", sessionId: currentSessionId, itemId: contextRemove.dataset.item });
    return;
  }
  const contextImage = event.target.closest("[data-context-image]");
  if (contextImage) {
    vscode.postMessage({ type: "addContextImage", sessionId: contextImage.dataset.session });
    return;
  }
  const compactBtn = event.target.closest("[data-compact-session]");
  if (compactBtn) {
    vscode.postMessage({ type: "compactSession", sessionId: compactBtn.dataset.session });
    return;
  }
  const sessionRow = event.target.closest("[data-session]:not([data-action])");
  if (sessionRow) {
    vscode.postMessage({ type: "openSession", sessionId: sessionRow.dataset.session });
    return;
  }
  const button = event.target.closest("[data-action]");
  if (!button) return;
  if (button.dataset.action === "back-to-sessions") {
    vscode.postMessage({ type: "tab", tab: "sessions" });
    return;
  }
  if (button.dataset.action === "back-to-gate") {
    const runId = activeRunId;
    if (runId) vscode.postMessage({ type: "openRun", runId });
    return;
  }
  if (button.dataset.action === "continue-session") {
    const prompt = $("continue-prompt").value.trim();
    if (!prompt) return;
    // Switch to the Run tab so the new turn streams where every other run
    // streams, rather than inventing a second live view.
    showTab("run");
    vscode.postMessage({
      type: "startRun",
      mode,
      agentId: $("agent").value,
      workerId: mode === "single" ? undefined : $("worker").value,
      repoPath: $("repo").value.trim(),
      prompt,
      sessionId: button.dataset.session,
      attachments: [],
    });
    return;
  }
  if (button.dataset.action === "git-refresh") {
    vscode.postMessage({ type: "gitRefresh" });
    return;
  }
  if (button.dataset.action === "git-select-all") {
    const group = $("tab-git").querySelector('[data-git-group="' + button.dataset.group + '"]');
    if (group) {
      const boxes = [...group.querySelectorAll("input[data-git-path]")];
      // Toggle: a second press clears, so "select all" cannot strand the user
      // with a selection they have to undo one box at a time.
      const turnOn = boxes.some((box) => !box.checked);
      for (const box of boxes) box.checked = turnOn;
    }
    return;
  }
  if (button.dataset.action === "git-stage" || button.dataset.action === "git-unstage") {
    const unstage = button.dataset.action === "git-unstage";
    const group = $("tab-git").querySelector('[data-git-group="' + (unstage ? "unstage" : "stage") + '"]');
    const paths = group
      ? [...group.querySelectorAll("input[data-git-path]")]
          .filter((box) => box.checked)
          .map((box) => box.dataset.gitPath)
      : [];
    vscode.postMessage({ type: "gitStage", paths, unstage });
    return;
  }
  if (button.dataset.action === "git-switch") {
    const select = $("git-branch-select");
    vscode.postMessage({ type: "gitBranch", name: select ? select.value : "", create: false });
    return;
  }
  if (button.dataset.action === "git-create-branch") {
    const box = $("git-branch-new");
    vscode.postMessage({ type: "gitBranch", name: box ? box.value : "", create: true });
    if (box) box.value = "";
    return;
  }
  if (button.dataset.action === "git-commit") {
    const box = $("git-message");
    vscode.postMessage({ type: "gitCommit", message: box ? box.value : "" });
    if (box) box.value = "";
    return;
  }
  if (button.dataset.action === "git-push") {
    vscode.postMessage({ type: "gitPush", setUpstream: true });
    return;
  }
  if (button.dataset.action === "git-pull") {
    vscode.postMessage({ type: "gitPull", rebase: false });
    return;
  }
  if (button.dataset.action === "git-create-pr") {
    const titleBox = $("git-pr-title");
    const bodyBox = $("git-pr-body");
    const draftBox = $("git-pr-draft");
    vscode.postMessage({
      type: "gitCreatePr",
      title: titleBox ? titleBox.value : "",
      body: bodyBox ? bodyBox.value : "",
      draft: draftBox ? draftBox.checked : false,
    });
    return;
  }
  if (button.dataset.action === "apply-diff" || button.dataset.action === "revert-diff"
      || button.dataset.action === "force-apply-diff" || button.dataset.action === "force-revert-diff") {
    const runId = activeRunId;
    if (!runId) return;
    const type = button.dataset.action === "apply-diff" ? "applyDiff"
      : button.dataset.action === "force-apply-diff" ? "forceApplyDiff"
      : button.dataset.action === "force-revert-diff" ? "forceRevertDiff"
      : "revertDiff";
    // Absent on the whole-run buttons, which is what tells the daemon to take
    // the entire patch rather than one file of it.
    vscode.postMessage({ type, runId, filePath: button.dataset.file });
    return;
  }
  const runId = button.dataset.run;
  const actions = { open: "openRun", retry: "retry", diff: "viewDiff", merge: "merge" };
  const type = actions[button.dataset.action];
  if (type && runId) vscode.postMessage({ type, runId });
});

// Paste handler for images in the session transcript.
document.addEventListener("paste", (event) => {
  const items = event.clipboardData?.items;
  if (!items) return;
  for (let i = 0; i < items.length; i++) {
    if (items[i].kind === "file" && items[i].type.startsWith("image/")) {
      event.preventDefault();
      const file = items[i].getAsFile();
      if (!file || !currentSessionId) return;
      // Read the image as base64 and send to extension for saving
      const reader = new FileReader();
      reader.onload = (e) => {
        vscode.postMessage({
          type: "pasteImage",
          sessionId: currentSessionId,
          dataUrl: e.target.result,
          fileName: "pasted-" + Date.now() + ".png",
        });
      };
      reader.readAsDataURL(file);
      return;
    }
  }
});

// Drag-and-drop handler for images in the context items section.
let dragCounter = 0;
document.addEventListener("dragover", (event) => {
  const section = event.target.closest("#context-items-section");
  if (!section) return;
  const hasImage = Array.from(event.dataTransfer?.files ?? []).some((f) => f.type.startsWith("image/"));
  if (!hasImage) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "copy";
});
document.addEventListener("drop", (event) => {
  const section = event.target.closest("#context-items-section");
  if (!section) return;
  const files = Array.from(event.dataTransfer?.files ?? []).filter((f) => f.type.startsWith("image/"));
  if (files.length === 0) return;
  event.preventDefault();
  for (const file of files) {
    const reader = new FileReader();
    reader.onload = (e) => {
      vscode.postMessage({
        type: "pasteImage",
        sessionId: currentSessionId,
        dataUrl: e.target.result,
        fileName: file.name,
      });
    };
    reader.readAsDataURL(file);
  }
});

vscode.postMessage({ type: "ready" });
</script>
</body>
</html>`;
}
