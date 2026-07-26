import path from "node:path";
import type { BremioRunReport, RunReport, SingleRunReport } from "@bremio/orchestrator";
import { formatTaskExecution, renderEvent, type EventView } from "@bremio/event-view";
import type { Plan, TaskStatus } from "@bremio/protocol";

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);

export const c = {
  bold: wrap("1"),
  dim: wrap("2"),
  red: wrap("31"),
  green: wrap("32"),
  yellow: wrap("33"),
  cyan: wrap("36"),
};

export function statusGlyph(status: TaskStatus): string {
  switch (status) {
    case "completed":
      return c.green("✓ completed");
    case "failed":
      return c.red("✗ failed");
    case "cancelled":
      return c.yellow("◼ cancelled");
  }
}

/** Colour the summary by severity so the terminal rendering has a consistent scheme. */
export function formatEventView(view: EventView): string {
  switch (view.severity) {
    case "error": return c.red(view.summary);
    case "success": return c.green(view.summary);
    case "warn": return c.yellow(view.summary);
    case "notice": return c.dim(view.summary);
    case "info": return view.summary;
  }
}

/**
 * Render a daemon RunEvent through the same {@link renderEvent} pipeline that
 * the in-process path uses, giving parity in output format between the two.
 */
export function renderRunEvent(event: {
  kind: string;
  message?: string;
  data?: unknown;
}): string {
  const dataObj =
    typeof event.data === "object" && event.data !== null
      ? (event.data as Record<string, unknown>)
      : undefined;
  const evType =
    event.kind === "failed" ? "error"
      : event.kind === "task-event" ? "message"
        : event.kind;
  const agentEv: Parameters<typeof renderEvent>[0] = dataObj
    ? Object.assign({ type: evType } as { type: string }, dataObj)
    : { type: evType, text: event.message ?? "", message: event.message };
  return formatEventView(renderEvent(agentEv));
}

export function printPlan(
  plan: Plan,
  assign: Map<string, string>,
  reasonByTask?: ReadonlyMap<string, string>,
): void {
  console.log(`\n${c.bold("Plan")}: ${plan.summary}`);
  for (const t of plan.tasks) {
    const agent = assign.get(t.id) ?? "?";
    const reason = reasonByTask?.get(t.id);
    const deps = t.dependencies.length ? c.dim(` ⇠ ${t.dependencies.join(", ")}`) : "";
    const reasonText = reason ? c.dim(` (${reason})`) : "";
    console.log(
      `  ${c.cyan(t.id)}  ${t.kind.padEnd(14)} ${c.bold(`→ ${agent}`)}${reasonText}  ${c.dim(`[${t.risk}]`)}${deps}`,
    );
    console.log(`      ${t.title}`);
  }
}

export function printReport(report: BremioRunReport): void {
  if (report.mode === "single") {
    printSingleReport(report);
    return;
  }
  printTeamReport(report);
}

function printTeamReport(report: RunReport): void {
  const rel = (p?: string) => (p ? path.relative(report.repoPath, p) || p : "");
  const line = "─".repeat(60);
  console.log(`\n${line}`);
  console.log(` ${c.bold("Bremio report")}  ${c.dim(report.runId)}`);
  const leadExec = formatTaskExecution({
    agentId: report.leadAgentId,
    requestedModel: report.leadRequestedModel,
    confirmedModel: report.leadActualModel,
    requestedReasoningLevel: report.leadRequestedReasoningLevel,
    confirmedReasoningLevel: report.leadActualReasoningLevel,
  });
  console.log(` lead: ${c.cyan(report.leadAgentId)} (${c.dim(leadExec)})   repo: ${c.dim(report.repoPath)}`);
  if (report.autoModeReason) console.log(` mode: ${c.cyan("auto")}  ${c.dim(report.autoModeReason)}`);
  console.log(line);

  for (const { task, agentId, result, reason } of report.tasks) {
    console.log(
      `\n${c.cyan(task.id)} ${c.bold(task.title)}  ${c.dim(`(${task.kind})`)}`,
    );
    const reasonText = reason ? c.dim(` (${reason})`) : "";
    console.log(
      `  agent: ${c.bold(agentId)}${reasonText}   status: ${statusGlyph(result.status)}   files: ${result.filesChanged.length}`,
    );
    const execInfo = formatTaskExecution({
      agentId,
      requestedModel: result.requestedModel,
      confirmedModel: result.actualModel,
      requestedReasoningLevel: result.requestedReasoningLevel,
      confirmedReasoningLevel: result.actualReasoningLevel,
    });
    const duration = result.durationMs !== undefined ? `duration=${(result.durationMs / 1000).toFixed(1)}s` : undefined;
    console.log(`  execution: ${c.dim([execInfo, duration].filter(Boolean).join(" | "))}`);
    if (result.filesChanged.length) {
      console.log(`  changed: ${c.dim(result.filesChanged.join(", "))}`);
    }
    if (result.commitHash) {
      console.log(`  commit: ${c.dim(result.commitHash.slice(0, 12))}   branch: ${c.dim(result.branch ?? "")}`);
    }
    if (result.worktreePath) console.log(`  worktree: ${c.dim(rel(result.worktreePath))}`);
    if (result.logsPath) console.log(`  log: ${c.dim(rel(result.logsPath))}`);
    if (result.error) console.log(`  ${c.red(`error: ${result.error}`)}`);
  }

  const s = report.summary;
  const gate = report.qualityGate;
  console.log(`\n${line}`);
  console.log(
    ` ${c.bold("Summary")}: ${c.green(`${s.completed} completed`)}, ` +
      `${c.red(`${s.failed} failed`)}, ${c.yellow(`${s.cancelled} cancelled`)} ` +
      `— ${s.filesChanged} file(s) changed across ${s.total} task(s)`,
  );
  if (gate) {
    const gateText = gate.status === "passed"
      ? c.green("passed")
      : gate.status === "failed"
        ? c.red("failed")
        : c.yellow("not run");
    console.log(` ${c.bold("Quality gate")}: ${gateText}`);
    for (const reason of gate.reasons) console.log(`   ${c.red(`- ${reason}`)}`);
  }
  console.log(` report:    ${c.dim(rel(path.join(report.runDir, "report.json")))}`);
  console.log(
    ` ${c.dim("worktrees left under .bremio/worktrees/ for manual review (no auto-merge)")}`,
  );
  console.log(line);
}

function printSingleReport(report: SingleRunReport): void {
  const rel = (p?: string) => (p ? path.relative(report.repoPath, p) || p : "");
  const line = "─".repeat(60);
  const { result, verification } = report;
  console.log(`\n${line}`);
  console.log(` ${c.bold("Bremio report")}  ${c.dim(report.runId)}`);
  console.log(
    ` mode: ${c.cyan("Single Agent")}   agent: ${c.cyan(report.primaryAgentId)} ` +
      `  repo: ${c.dim(report.repoPath)}`,
  );
  console.log(line);
  if (report.fallback) {
    console.log(` ${c.yellow("Team fallback")}: ${report.fallback.reason}`);
    console.log(
      ` ${c.dim(`planning run ${report.fallback.teamRunId}; baseline ${report.fallback.baselineRunId}`)}`,
    );
    console.log(line);
  }
  console.log(` status: ${statusGlyph(result.status)}   files: ${result.filesChanged.length}`);
  const verificationText = verification.status === "passed"
    ? c.green("passed")
    : verification.status === "failed"
      ? c.red("failed")
      : c.yellow("unverified");
  console.log(` verification: ${verificationText}`);
  for (const reason of verification.reasons) console.log(`   ${c.dim(`- ${reason}`)}`);
  const singleExec = formatTaskExecution({
    agentId: report.primaryAgentId,
    requestedModel: result.requestedModel,
    confirmedModel: result.actualModel,
    requestedReasoningLevel: result.requestedReasoningLevel,
    confirmedReasoningLevel: result.actualReasoningLevel,
  });
  const duration = result.durationMs !== undefined ? `duration=${(result.durationMs / 1000).toFixed(1)}s` : undefined;
  console.log(` execution: ${c.dim([singleExec, duration].filter(Boolean).join(" | "))}`);
  if (result.filesChanged.length > 0) {
    console.log(` changed/dirty: ${c.dim(result.filesChanged.join(", "))}`);
  }
  if (result.error) console.log(` ${c.red(`error: ${result.error}`)}`);
  console.log(` log:       ${c.dim(rel(result.logsPath))}`);
  console.log(` report:    ${c.dim(rel(path.join(report.runDir, "report.json")))}`);
  console.log(c.dim(" current workspace was used directly; no worktree or merge step was created"));
  console.log(line);
}
