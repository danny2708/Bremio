import path from "node:path";
import type { RunReport } from "@bremio/orchestrator";
import type { AgentEvent, Plan, TaskStatus } from "@bremio/protocol";

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code: string) => (s: string) => (useColor ? `[${code}m${s}[0m` : s);

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

/** A compact one-line rendering of a live event, or undefined to skip it. */
export function compactEvent(event: AgentEvent): string | undefined {
  const clip = (s: string, n = 100) => {
    const one = s.replace(/\s+/g, " ").trim();
    return one.length > n ? `${one.slice(0, n)}…` : one;
  };
  switch (event.type) {
    case "tool_use": {
      const input = event.input as { command?: unknown; file_path?: unknown } | undefined;
      const arg = typeof input?.command === "string"
        ? input.command
        : typeof input?.file_path === "string"
          ? input.file_path
          : "";
      return c.dim(`   · ${event.name}${arg ? ` ${clip(String(arg), 70)}` : ""}`);
    }
    case "error":
      return c.red(`   ! ${clip(event.message)}`);
    default:
      return undefined;
  }
}

export function printPlan(plan: Plan, assign: Map<string, string>): void {
  console.log(`\n${c.bold("Plan")}: ${plan.summary}`);
  for (const t of plan.tasks) {
    const agent = assign.get(t.id) ?? "?";
    const deps = t.dependencies.length ? c.dim(` ⇠ ${t.dependencies.join(", ")}`) : "";
    console.log(
      `  ${c.cyan(t.id)}  ${t.kind.padEnd(14)} ${c.bold(`→ ${agent}`)}  ${c.dim(`[${t.risk}]`)}${deps}`,
    );
    console.log(`      ${t.title}`);
  }
}

export function printReport(report: RunReport): void {
  const rel = (p?: string) => (p ? path.relative(report.repoPath, p) || p : "");
  const line = "─".repeat(60);
  console.log(`\n${line}`);
  console.log(` ${c.bold("Bremio report")}  ${c.dim(report.runId)}`);
  console.log(` lead: ${c.cyan(report.leadAgentId)}   repo: ${c.dim(report.repoPath)}`);
  console.log(line);

  for (const { task, agentId, result } of report.tasks) {
    console.log(
      `\n${c.cyan(task.id)} ${c.bold(task.title)}  ${c.dim(`(${task.kind})`)}`,
    );
    console.log(
      `  agent: ${c.bold(agentId)}   status: ${statusGlyph(result.status)}   files: ${result.filesChanged.length}`,
    );
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
  console.log(`\n${line}`);
  console.log(
    ` ${c.bold("Summary")}: ${c.green(`${s.completed} completed`)}, ` +
      `${c.red(`${s.failed} failed`)}, ${c.yellow(`${s.cancelled} cancelled`)} ` +
      `— ${s.filesChanged} file(s) changed across ${s.total} task(s)`,
  );
  console.log(` report:    ${c.dim(rel(path.join(report.runDir, "report.json")))}`);
  console.log(
    ` ${c.dim("worktrees left under .bremio/worktrees/ for manual review (no auto-merge)")}`,
  );
  console.log(line);
}
