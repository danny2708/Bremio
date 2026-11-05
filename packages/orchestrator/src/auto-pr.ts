import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { evaluate, type ControlMode } from "@bremio/policy";
import { GitOps } from "@bremio/workspace";
import type { RunReport } from "./aggregator";
import type { SingleRunReport } from "./single-run";

const execFileAsync = promisify(execFile);

/**
 * Opt-in auto-PR on green (P2-T7, docs/17, docs/19).
 *
 * Reuses the S10-T12/T13 paths (`GitOps.push`, `GitOps.createPullRequest`
 * via `gh`) and never touches the user's checkout: a Team run's completed
 * implementation branches are merged onto a fresh `bremio/pr-<runId>` branch
 * in a temporary worktree; a Single run pushes its isolated worktree branch.
 *
 * Refusals are named and never throw: auto-PR is a convenience after a
 * finished run, and must not turn a green run into a failed one.
 */
export interface AutoPrResult {
  status: "opened" | "refused" | "failed";
  reason?: string;
  branch?: string;
  url?: string;
}

type GhRunner = ConstructorParameters<typeof GitOps>[1];

export interface AutoPrDeps {
  /** Injected for tests; defaults to the real `gh` CLI. */
  ghRunner?: GhRunner;
}

/** Why policy forbids pushing and opening a PR without a person. */
export function autoPrPolicyBlock(controlMode: ControlMode): string | undefined {
  const rule = evaluate(controlMode, "network");
  if (!rule.allowed) return `${controlMode} mode does not allow auto-PR: ${rule.reason}`;
  if (rule.approvalRequired !== "none") {
    return `${controlMode} mode requires ${rule.approvalRequired} approval for network actions; auto-PR cannot run unattended`;
  }
  return undefined;
}

export async function openTeamAutoPr(report: RunReport, deps: AutoPrDeps = {}): Promise<AutoPrResult> {
  const block = autoPrPolicyBlock(report.controlMode ?? "autopilot");
  if (block) return { status: "refused", reason: block };
  if (report.qualityGate.status !== "passed") {
    return { status: "refused", reason: `quality gate is ${report.qualityGate.status}; auto-PR opens only on green` };
  }
  if (!report.baseBranch) return { status: "refused", reason: "run recorded no base branch" };

  const superseded = new Set([
    ...(report.fixLoop?.superseded ?? []),
    ...(report.replan?.replans.flatMap((r) => r.replaced) ?? []),
  ]);
  const branches = report.tasks
    .filter((t) => t.task.kind === "implementation" && !superseded.has(t.task.id))
    .filter((t) => t.result.status === "completed" && t.result.branch)
    .map((t) => t.result.branch!);
  if (branches.length === 0) return { status: "refused", reason: "no completed implementation branch to propose" };

  const branch = `bremio/pr-${report.runId}`;
  const worktree = path.join(report.repoPath, ".bremio", "worktrees", `pr-${report.runId}`);
  const git = (args: string[], cwd = report.repoPath) => execFileAsync("git", args, { cwd, encoding: "utf8" });
  try {
    await git(["worktree", "add", "-b", branch, worktree, report.baseBranch]);
  } catch (err) {
    return { status: "failed", reason: `could not prepare ${branch}: ${(err as Error).message}`, branch };
  }
  try {
    for (const source of branches) {
      try {
        await git(["merge", "--no-ff", "--no-edit", source], worktree);
      } catch (err) {
        await git(["merge", "--abort"], worktree).catch(() => {});
        return { status: "failed", reason: `merging ${source} conflicted: ${firstLine(err)}`, branch };
      }
    }
    return await pushAndOpen(worktree, branch, report.baseBranch, teamTitle(report), teamBody(report), deps);
  } finally {
    await git(["worktree", "remove", "--force", worktree]).catch(() => {});
    await fs.rm(worktree, { recursive: true, force: true }).catch(() => {});
  }
}

export async function openSingleAutoPr(
  report: SingleRunReport,
  baseBranch: string | undefined,
  deps: AutoPrDeps = {},
): Promise<AutoPrResult> {
  const block = autoPrPolicyBlock(report.controlMode ?? "autopilot");
  if (block) return { status: "refused", reason: block };
  if (report.verification.status !== "passed") {
    return { status: "refused", reason: `verification is ${report.verification.status}; auto-PR opens only on green` };
  }
  if (!report.worktree) {
    return {
      status: "refused",
      reason: "auto-PR needs an isolated worktree; direct-workspace changes are uncommitted in your own tree",
    };
  }
  if (!baseBranch) return { status: "refused", reason: "could not determine the base branch" };
  return pushAndOpen(
    report.worktree.path,
    report.worktree.branch,
    baseBranch,
    `bremio: ${firstLineOf(report.prompt)}`,
    singleBody(report),
    deps,
  );
}

async function pushAndOpen(
  cwd: string,
  branch: string,
  base: string,
  title: string,
  body: string,
  deps: AutoPrDeps,
): Promise<AutoPrResult> {
  const ops = deps.ghRunner ? new GitOps(cwd, deps.ghRunner) : new GitOps(cwd);
  // Refuse before pushing: a branch pushed for a PR that cannot be opened is
  // a side effect on the remote with nothing to show for it.
  try {
    await ops.assertPullRequestPossible();
  } catch (err) {
    return { status: "failed", reason: (err as Error).message, branch };
  }
  try {
    await ops.push({ branch, setUpstream: true });
  } catch (err) {
    return { status: "failed", reason: `push failed: ${(err as Error).message}`, branch };
  }
  try {
    const { url } = await ops.createPullRequest({ title, body, base, head: branch });
    return { status: "opened", url, branch };
  } catch (err) {
    return { status: "failed", reason: (err as Error).message, branch };
  }
}

function teamTitle(report: RunReport): string {
  return `bremio: ${firstLineOf(report.plan.summary)}`;
}

function teamBody(report: RunReport): string {
  const lines = [
    `Opened by Bremio after Team run \`${report.runId}\` passed its quality gate.`,
    "",
    `**Request:** ${firstLineOf(report.prompt)}`,
    "",
    "## Tasks",
    ...report.tasks.map((t) => `- ${t.task.id} (${t.task.kind}, ${t.agentId}): ${t.result.status}`),
  ];
  if (report.fixLoop && report.fixLoop.iterations.length > 0) {
    lines.push("", `## Fix iterations: ${report.fixLoop.iterations.length} (${report.fixLoop.status})`);
  }
  if (report.definitionOfDone) {
    lines.push("", `## Definition of done: ${report.definitionOfDone.status}`);
    for (const c of report.definitionOfDone.criteria) lines.push(`- [${c.status === "evidenced" ? "x" : " "}] ${c.criterion} (${c.status})`);
  }
  lines.push("", `## Cost: ${costLine(report.tasks.map((t) => t.result.usage?.costUsd))}`);
  return lines.join("\n");
}

function singleBody(report: SingleRunReport): string {
  return [
    `Opened by Bremio after Single run \`${report.runId}\` (${report.primaryAgentId}) passed verification.`,
    "",
    `**Request:** ${firstLineOf(report.prompt)}`,
    "",
    `Files changed: ${report.result.filesChanged.length}`,
    `Cost: ${costLine([report.result.usage?.costUsd])}`,
  ].join("\n");
}

/** Provider-reported cost, or "unknown" — never estimated. */
function costLine(values: Array<number | undefined>): string {
  if (values.length === 0 || values.some((v) => v === undefined)) return "unknown (not every run reported cost)";
  return `$${values.reduce((sum: number, v) => sum + (v ?? 0), 0).toFixed(4)} (provider-reported)`;
}

function firstLineOf(text: string): string {
  const line = text.split("\n")[0]?.trim() ?? "";
  return line.length > 72 ? `${line.slice(0, 71)}…` : line;
}

function firstLine(err: unknown): string {
  return ((err as Error).message ?? String(err)).split("\n")[0] ?? "";
}
