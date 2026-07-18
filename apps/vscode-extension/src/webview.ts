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
 * The palette is fixed dark rather than inherited from the VS Code theme, which
 * is a deliberate brand choice. Everything routes through CSS variables, so a
 * light variant is one `@media (prefers-color-scheme: light)` block away.
 */

export function panelHtml(nonce: string, cspSource: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Bremio</title>
<style>
:root {
  --bremio-primary: #2563eb;
  --bremio-primary-hover: #3b82f6;
  --bremio-primary-active: #1d4ed8;
  --bremio-primary-muted: #172554;

  --bremio-accent: #f4c542;
  --bremio-accent-hover: #ffd75e;
  --bremio-accent-active: #d9a91e;
  --bremio-accent-muted: #3a3216;

  --bremio-bg: #0b1220;
  --bremio-surface: #111827;
  --bremio-surface-elevated: #182235;
  --bremio-border: #263348;

  --bremio-text: #f8fafc;
  --bremio-text-secondary: #b8c2d1;
  --bremio-text-muted: #7f8a9c;

  --bremio-success: #34a77b;
  --bremio-danger: #e0575b;

  --agent-claude: #c9864a;
  --agent-codex: #34a77b;
  --agent-antigravity: #7c83f6;
  --agent-opencode: #a071d1;
  --agent-jan: #32b8c6;
}

* { box-sizing: border-box; }

body {
  margin: 0;
  background: var(--bremio-bg);
  color: var(--bremio-text);
  font-family: var(--vscode-font-family, system-ui, sans-serif);
  font-size: 13px;
  line-height: 1.5;
}

header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--bremio-border);
  background: var(--bremio-surface);
}

.logo {
  width: 22px; height: 22px; border-radius: 6px;
  background: var(--bremio-primary);
  display: grid; place-items: center;
  color: var(--bremio-accent);
  font-weight: 700; font-size: 13px;
  flex: none;
}
.wordmark { font-weight: 600; letter-spacing: .2px; }
.tagline { color: var(--bremio-text-muted); font-size: 11px; }
.spacer { flex: 1; }

.status-dot {
  width: 8px; height: 8px; border-radius: 50%;
  background: var(--bremio-text-muted);
  flex: none;
}
.status-dot.live { background: var(--bremio-success); }
.status-dot.down { background: var(--bremio-danger); }

nav { display: flex; gap: 2px; padding: 0 12px; background: var(--bremio-surface); border-bottom: 1px solid var(--bremio-border); }
nav button {
  background: none; border: none; border-bottom: 2px solid transparent;
  color: var(--bremio-text-secondary); padding: 9px 12px; cursor: pointer;
  font-size: 12px; font-family: inherit;
}
nav button:hover { color: var(--bremio-text); }
/* Blue marks where you are — system state, never an action. */
nav button.active { color: var(--bremio-text); border-bottom-color: var(--bremio-primary); }

main { padding: 16px; }
section { display: none; }
section.active { display: block; }

.card {
  background: var(--bremio-surface);
  border: 1px solid var(--bremio-border);
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
.badge.lead { background: var(--bremio-accent); color: #241d00; }
.badge.ok { background: var(--bremio-primary-muted); color: var(--bremio-primary-hover); }
.badge.warn { background: var(--bremio-accent-muted); color: var(--bremio-accent-hover); }
.badge.bad { background: #3a1c1e; color: var(--bremio-danger); }

.agent { display: inline-flex; align-items: center; gap: 6px; }
.agent::before { content: ""; width: 8px; height: 8px; border-radius: 2px; background: var(--bremio-text-muted); }
.agent[data-agent="claude"]::before { background: var(--agent-claude); }
.agent[data-agent="codex"]::before { background: var(--agent-codex); }
.agent[data-agent="antigravity"]::before { background: var(--agent-antigravity); }

.meter { height: 6px; border-radius: 3px; background: var(--bremio-surface-elevated); overflow: hidden; margin-top: 4px; }
.meter > span { display: block; height: 100%; background: var(--bremio-primary); }
.meter.warn > span { background: var(--bremio-accent); }
.meter.bad > span { background: var(--bremio-danger); }

.muted { color: var(--bremio-text-muted); }
.secondary { color: var(--bremio-text-secondary); }
.row { display: flex; align-items: center; gap: 8px; }
.between { justify-content: space-between; }
.window { margin: 8px 0; }
.window-label { display: flex; justify-content: space-between; font-size: 11px; }

label { display: block; font-size: 11px; color: var(--bremio-text-secondary); margin: 10px 0 4px; }
input, select, textarea {
  width: 100%; background: var(--bremio-bg); color: var(--bremio-text);
  border: 1px solid var(--bremio-border); border-radius: 6px;
  padding: 7px 9px; font-family: inherit; font-size: 12px;
}
input:focus, select:focus, textarea:focus { outline: none; border-color: var(--bremio-primary); }
textarea { resize: vertical; min-height: 72px; }

.seg { display: flex; gap: 6px; }
.seg button {
  flex: 1; padding: 7px; border-radius: 6px; cursor: pointer; font-family: inherit; font-size: 12px;
  background: var(--bremio-bg); color: var(--bremio-text-secondary);
  border: 1px solid var(--bremio-border);
}
/* Selection is system state, so it is blue. */
.seg button.on { border-color: var(--bremio-primary); color: var(--bremio-text); background: var(--bremio-primary-muted); }

button.primary {
  /* The one action on the screen — yellow, and small. */
  background: var(--bremio-accent); color: #241d00; border: none;
  padding: 8px 16px; border-radius: 6px; font-weight: 600; cursor: pointer;
  font-family: inherit; font-size: 12px;
}
button.primary:hover { background: var(--bremio-accent-hover); }
button.primary:active { background: var(--bremio-accent-active); }
button.primary:disabled { background: var(--bremio-surface-elevated); color: var(--bremio-text-muted); cursor: not-allowed; }

button.ghost {
  background: none; border: 1px solid var(--bremio-border); color: var(--bremio-text-secondary);
  padding: 6px 12px; border-radius: 6px; cursor: pointer; font-family: inherit; font-size: 12px;
}
button.ghost:hover { border-color: var(--bremio-primary); color: var(--bremio-text); }

pre.log {
  background: var(--bremio-bg); border: 1px solid var(--bremio-border); border-radius: 6px;
  padding: 10px; max-height: 320px; overflow: auto; font-size: 11px;
  font-family: var(--vscode-editor-font-family, monospace); white-space: pre-wrap; margin: 0;
}
.log-line { display: block; }
.log-task { color: var(--bremio-primary-hover); }
.log-lead { color: var(--bremio-accent); }
.log-fail { color: var(--bremio-danger); }
.log-done { color: var(--bremio-success); }

.empty { color: var(--bremio-text-muted); padding: 24px; text-align: center; }
.banner { border-radius: 6px; padding: 8px 10px; margin-bottom: 10px; font-size: 12px; }
.banner.warn { background: var(--bremio-accent-muted); color: var(--bremio-accent-hover); }
.banner.bad { background: #3a1c1e; color: var(--bremio-danger); }
</style>
</head>
<body>
<header>
  <div class="logo">B</div>
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
      <input id="repo" type="text" placeholder="/path/to/repo">

      <label>Prompt</label>
      <textarea id="prompt" placeholder="add a health endpoint"></textarea>

      <div class="row between" style="margin-top:12px">
        <span class="muted" id="run-hint"></span>
        <button class="primary" id="start">Run</button>
      </div>
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

$("start").addEventListener("click", () => {
  vscode.postMessage({
    type: "startRun",
    mode,
    agentId: $("agent").value,
    workerId: mode === "team" ? $("worker").value : undefined,
    maxConcurrency: mode === "team" ? Number($("concurrency").value) : undefined,
    repoPath: $("repo").value.trim(),
    prompt: $("prompt").value.trim(),
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
  const line = document.createElement("span");
  line.className = "log-line";
  const cls = event.kind === "failed" ? "log-fail"
    : event.kind === "finished" ? "log-done"
    : event.kind === "lead" ? "log-lead"
    : "log-task";
  const tag = event.taskId ? "[" + event.taskId + "] " : "";
  line.innerHTML = '<span class="' + cls + '">' + escapeHtml(tag) + "</span>" + escapeHtml(event.message);
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
    $("tab-capacity").innerHTML = renderCapacity(message.capacity);
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

function renderCapacity(capacity) {
  if (capacity.error) return '<div class="banner bad">' + escapeHtml(capacity.error) + "</div>";
  const live = capacity.service?.state === "live";
  const banner = live
    ? ""
    : '<div class="banner warn">AI-Quota-Tray is not responding — values below are last-known, not live.</div>';
  return banner + (capacity.snapshots ?? []).map((s) => \`
    <div class="card">
      <div class="card-head">
        <span class="agent" data-agent="\${escapeHtml(s.agentId)}"><span class="card-title">\${escapeHtml(s.agentId)}</span></span>
        <span class="badge \${s.status === "healthy" ? "ok" : s.status === "unknown" ? "warn" : "bad"}">\${escapeHtml(s.status)}</span>
        <div class="spacer"></div>
        <span class="muted">contact \${escapeHtml(s.contactFreshness)}</span>
      </div>
      \${(s.windows ?? []).map((w) => {
        const pct = w.remainingPercent;
        const cls = pct === undefined ? "" : pct >= 50 ? "" : pct >= 20 ? "warn" : "bad";
        return \`<div class="window">
          <div class="window-label"><span class="secondary">\${escapeHtml(w.label)}</span>
          <span class="muted">\${pct === undefined ? "unknown" : pct.toFixed(0) + "%"} · \${escapeHtml(w.freshness)}</span></div>
          <div class="meter \${cls}"><span style="width:\${pct === undefined ? 0 : pct}%"></span></div>
        </div>\`;
      }).join("")}
      \${(s.windows ?? []).length === 0 ? '<div class="muted">no quota windows reported</div>' : ""}
    </div>\`).join("");
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
document.addEventListener("click", (event) => {
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
