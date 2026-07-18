import { existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import {
  CherryPickConflictError,
  MergeConflictError,
  MergeManager,
  MergeStateError,
} from "@bremio/workspace";
import {
  findTaskAcrossReports,
  listReports,
  loadReportByRunId,
  type RunReport,
  type RunReportTask,
} from "@bremio/orchestrator";
import { c } from "./ui";

export interface MergeCommandOptions {
  repoPath: string;
  taskId?: string;
  runId?: string;
  base?: string;
  strategy?: "merge" | "cherry-pick";
  assumeYes: boolean;
}

/** Resolve which report + which tasks the merge should target. */
async function resolveTargets(
  opts: MergeCommandOptions,
): Promise<{ report: RunReport; tasks: RunReportTask[] } | { error: string }> {
  const reports = await listReports(opts.repoPath);
  if (reports.length === 0) {
    return { error: "no Bremio runs found under .bremio/runs" };
  }

  if (opts.runId) {
    const stored = await loadReportByRunId(opts.repoPath, opts.runId);
    if (!stored) return { error: `no run "${opts.runId}" found` };
    if (stored.report.mode === "single") {
      return {
        error:
          `run "${opts.runId}" used Single mode and edited the current workspace directly; ` +
          "there is no Bremio branch to merge",
      };
    }
    const tasks = opts.taskId
      ? stored.report.tasks.filter((t) => t.task.id === opts.taskId)
      : stored.report.tasks;
    if (tasks.length === 0) {
      return { error: `task "${opts.taskId}" not found in run "${opts.runId}"` };
    }
    return { report: stored.report, tasks };
  }

  if (opts.taskId) {
    const matches = findTaskAcrossReports(reports, opts.taskId);
    if (matches.length === 0) return { error: `task "${opts.taskId}" not found in any run` };
    if (matches.length > 1) {
      const runs = matches.map((m) => m.stored.runId).join(", ");
      return {
        error: `task "${opts.taskId}" appears in multiple runs (${runs}); disambiguate with --run <runId>`,
      };
    }
    const only = matches[0];
    if (!only) return { error: `task "${opts.taskId}" not found in any run` };
    return { report: only.stored.report, tasks: [only.entry] };
  }

  return { error: "specify a <taskId> or --run <runId>" };
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(question)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

function printTaskForMerge(entry: RunReportTask, diff: { stat: string; patch: string }): void {
  const { task, agentId, result } = entry;
  console.log(`\n${c.cyan(task.id)} ${c.bold(task.title)}  ${c.dim(`(${task.kind}, ${agentId})`)}`);
  if (result.summary) console.log(c.dim(clip(result.summary, 400)));
  if (task.acceptanceCriteria.length) {
    console.log(c.bold("  acceptance criteria:"));
    for (const cr of task.acceptanceCriteria) console.log(`    - ${cr}`);
  }
  console.log(c.bold("\n  diff:"));
  console.log(diff.stat ? indent(diff.stat) : c.dim("    (no stat)"));
  if (diff.patch) console.log(`\n${diff.patch}`);
}

/** `bremio merge` — review a task's diff and, on confirmation, merge it into base. */
export async function mergeCommand(opts: MergeCommandOptions): Promise<number> {
  const resolved = await resolveTargets(opts);
  if ("error" in resolved) {
    console.error(c.red(`error: ${resolved.error}`));
    return 2;
  }
  const { report, tasks } = resolved;
  const strategy = opts.strategy ?? "merge";

  if (!report.qualityGate || report.qualityGate.status !== "passed") {
    const status = report.qualityGate?.status ?? "missing";
    console.error(c.red(`error: quality gate is ${status}; refusing to merge.`));
    for (const reason of report.qualityGate?.reasons ?? []) {
      console.error(c.red(`  - ${reason}`));
    }
    console.error(c.dim("  inspect the run report and rerun failed/missing test or review tasks."));
    return 2;
  }

  const mgr = new MergeManager(opts.repoPath);
  const current = await mgr.currentBranch();
  const base = opts.base ?? report.baseBranch ?? current;

  // Pre-flight once: we never switch branches or touch uncommitted work.
  if (current !== base) {
    console.error(
      c.red(`error: repository is on "${current}", not the base branch "${base}".`),
    );
    console.error(c.dim(`  run: git checkout ${base}   (or pass --base ${current})`));
    return 2;
  }
  if (await mgr.hasTrackedChanges()) {
    console.error(
      c.red("error: working tree has uncommitted changes to tracked files; commit or stash them first."),
    );
    return 2;
  }

  let merged = 0;
  for (const entry of tasks) {
    const { task, result } = entry;
    const label = `${c.cyan(task.id)} ${c.dim(`(${task.kind})`)}`;

    if (result.status !== "completed") {
      console.log(`\n${label} ${c.yellow(`status is "${result.status}", not completed — skipping`)}`);
      continue;
    }
    const branch = result.branch;
    if (!branch) {
      console.log(`\n${label} ${c.yellow("no branch recorded — skipping")}`);
      continue;
    }
    if (!(await mgr.branchExists(branch))) {
      console.log(`\n${label} ${c.yellow(`branch "${branch}" no longer exists (already merged?) — skipping`)}`);
      continue;
    }
    if (result.worktreePath && !existsSync(result.worktreePath)) {
      console.log(`${label} ${c.dim("note: worktree dir is gone; merging from the branch anyway")}`);
    }
    if (strategy === "cherry-pick" && !result.commitHash) {
      await mgr.cleanup(result.worktreePath ?? "", branch);
      console.log(`\n${label} ${c.yellow("no task-owned commit — cleaned up without integrating")}`);
      continue;
    }
    if (strategy === "merge") {
      const ahead = await mgr.commitsAhead(branch, base);
      if (ahead === 0) {
        await mgr.cleanup(result.worktreePath ?? "", branch);
        console.log(`\n${label} ${c.yellow("no changes left to merge — cleaned up")}`);
        continue;
      }
    }

    const diff = strategy === "cherry-pick"
      ? await mgr.getCommitDiff(result.commitHash as string)
      : await mgr.getDiff(branch, base);
    printTaskForMerge(entry, diff);

    const ok = opts.assumeYes
      ? true
      : process.stdin.isTTY
        ? await confirm(c.bold(`\n${strategy === "cherry-pick" ? "Cherry-pick" : "Merge"} ${branch} into ${base}? [y/N] `))
        : (console.log(c.yellow(`  not a TTY; re-run with --yes to ${strategy} non-interactively — skipping`)), false);

    if (!ok) {
      console.log(c.dim(`  left untouched. Inspect: git -C ${result.worktreePath ?? "."} diff ${base}...${branch}`));
      continue;
    }

    try {
      const integratedCommit = strategy === "cherry-pick"
        ? (await mgr.cherryPick(result.commitHash as string, base)).cherryPickCommit
        : (await mgr.merge(branch, base)).mergeCommit;
      await mgr.cleanup(result.worktreePath ?? "", branch);
      merged += 1;
      console.log(
        c.green(`  ✓ ${strategy === "cherry-pick" ? "cherry-picked" : "merged"} ${branch} into ${base} (${integratedCommit.slice(0, 10)}); worktree removed, branch deleted`),
      );
    } catch (err) {
      if (err instanceof CherryPickConflictError) {
        console.error(c.red(`\n  ✗ cherry-pick conflict in: ${err.files.join(", ") || "(unknown)"}`));
        console.error(c.dim("  the cherry-pick was aborted; your repo is unchanged. Resolve manually:"));
        console.error(c.dim(`    git checkout ${base} && git cherry-pick ${err.commit}`));
        return 1;
      }
      if (err instanceof MergeConflictError) {
        console.error(c.red(`\n  ✗ merge conflict in: ${err.files.join(", ") || "(unknown)"}`));
        console.error(c.dim("  the merge was aborted; your repo is unchanged. Resolve manually:"));
        console.error(c.dim(`    git checkout ${base} && git merge --no-ff ${branch}   # then fix conflicts`));
        return 1;
      }
      if (err instanceof MergeStateError) {
        console.error(c.red(`\n  ✗ ${err.message}`));
        return 2;
      }
      console.error(c.red(`\n  ✗ merge failed: ${(err as Error).message}`));
      return 1;
    }
  }

  console.log(`\n${c.bold("merged")} ${merged} task(s) into ${c.cyan(base)}.`);
  return 0;
}

function clip(s: string, n: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n)}…` : one;
}

function indent(s: string): string {
  return s
    .split("\n")
    .map((l) => `    ${l}`)
    .join("\n");
}
