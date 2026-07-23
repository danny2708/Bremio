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
      const one = (event.text ?? "").replace(/\s+/g, " ").trim();
      const clipped = one.length > 120 ? one.slice(0, 120) + "…" : one;
      return { kind: "message", summary: clipped, detail: event.text, severity: "info" };
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
      const model = event.model ?? "unknown model";
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

export function panelHtml(nonce: string, cspSource: string, iconUri = ""): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource}; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
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
  padding: 10px; max-height: 320px; overflow: auto; font-size: 11px;
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
  <div class="row"><span class="status-dot" id="daemon-dot"></span><span class="muted" id="daemon-status">connecting…</span></div>
</header>

<nav>
  <button data-tab="run" class="active">Run</button>
  <button data-tab="runs">Runs</button>
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
      </div>

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

  <section id="tab-runs"><div class="empty">Loading runs…</div></section>
  <section id="tab-capacity"><div class="empty">Loading capacity…</div></section>
  <section id="tab-doctor"><div class="empty">Checking adapters…</div></section>
</main>

<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);
let mode = "single";
let adapters = [];
let activeRunId = null;

document.querySelectorAll("nav button").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll("nav button").forEach((b) => b.classList.toggle("active", b === button));
    const tab = button.dataset.tab;
    document.querySelectorAll("main section").forEach((s) => s.classList.toggle("active", s.id === "tab-" + tab));
    vscode.postMessage({ type: "tab", tab });
  });
});

$("mode-seg").addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  mode = button.dataset.mode;
  document.querySelectorAll("#mode-seg button").forEach((b) => b.classList.toggle("on", b === button));
  $("agent-label").textContent = mode === "team" ? "Lead" : "Agent";
  $("worker-wrap").style.display = mode === "team" ? "block" : "none";
  $("concurrency-wrap").style.display = mode === "team" ? "block" : "none";
  renderAgentOptions();
});

function renderAgentOptions() {
  const agent = $("agent");
  const worker = $("worker");
  agent.innerHTML = "";
  worker.innerHTML = "";
  for (const a of adapters) {
    // Team lead must be lead-eligible; the capability contract decides, so a
    // provider without structured output simply cannot be offered here.
    if (mode === "team" && !a.leadEligible) continue;
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
  $("run-hint").textContent = mode === "team"
    ? "Lead plans; the worker executes in isolated git worktrees."
    : "One agent works directly in the repository.";
}

$("attach-files").addEventListener("click", () => vscode.postMessage({ type: "pickFiles" }));
$("attach-open").addEventListener("click", () => vscode.postMessage({ type: "attachActiveFile" }));

$("start").addEventListener("click", () => {
  vscode.postMessage({
    type: "startRun",
    mode,
    agentId: $("agent").value,
    workerId: mode === "team" ? $("worker").value : undefined,
    maxConcurrency: mode === "team" ? Number($("concurrency").value) : undefined,
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
  const view = event.data ? renderEvent(event.data) : null;
  const line = document.createElement("span");
  line.className = "log-line";
  const cls = event.kind === "failed" ? "log-fail"
    : event.kind === "finished" ? "log-done"
    : event.kind === "lead" ? "log-lead"
    : "log-task";
  const tag = event.taskId ? "[" + event.taskId + "] " : "";
  const text = view ? view.summary : event.message;
  line.innerHTML = '<span class="' + cls + '">' + escapeHtml(tag) + "</span>" + escapeHtml(text);
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
    $("tab-runs").innerHTML = renderRuns(message.runs);
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
});

function renderGate(gate, runId) {
  if (gate.status !== "passed") {
    return '<div class="banner warn"><strong>Quality gate: ' + escapeHtml(gate.status) + "</strong><br>"
      + gate.reasons.map(escapeHtml).join("<br>")
      + "<br>Merging stays blocked until the gate passes.</div>";
  }
  return '<div class="card"><div class="card-head"><span class="card-title">Quality gate passed</span>'
    + '<span class="badge ok">ready</span></div>'
    + '<div class="secondary">Review the diff, then merge into the base branch.</div>'
    + '<div class="row" style="margin-top:10px">'
    + '<button class="ghost" data-action="diff" data-run="' + escapeHtml(runId) + '">View diff</button>'
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
          <span class="muted">\${escapeHtml(run.mode)}</span></span>
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
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const runId = button.dataset.run;
  const actions = { open: "openRun", retry: "retry", diff: "viewDiff", merge: "merge" };
  const type = actions[button.dataset.action];
  if (type && runId) vscode.postMessage({ type, runId });
});

vscode.postMessage({ type: "ready" });
</script>
</body>
</html>`;
}
