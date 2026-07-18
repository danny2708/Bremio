import { promises as fs } from "node:fs";
import path from "node:path";
import type { RunReport, RunReportTask } from "@bremio/orchestrator";

export interface StoredReport {
  runId: string;
  path: string;
  report: RunReport;
}

/** Read every report.json under .bremio/runs for a repo, newest run id first. */
export async function listReports(repoPath: string): Promise<StoredReport[]> {
  const runsDir = path.join(repoPath, ".bremio", "runs");
  let entries: string[];
  try {
    entries = await fs.readdir(runsDir);
  } catch {
    return [];
  }

  const reports: StoredReport[] = [];
  for (const runId of entries) {
    const reportPath = path.join(runsDir, runId, "report.json");
    try {
      const raw = await fs.readFile(reportPath, "utf8");
      reports.push({ runId, path: reportPath, report: JSON.parse(raw) as RunReport });
    } catch {
      continue; // missing/corrupt report — skip
    }
  }
  reports.sort((a, b) => (a.runId < b.runId ? 1 : -1));
  return reports;
}

export async function loadReportByRunId(
  repoPath: string,
  runId: string,
): Promise<StoredReport | undefined> {
  const reportPath = path.join(repoPath, ".bremio", "runs", runId, "report.json");
  try {
    const raw = await fs.readFile(reportPath, "utf8");
    return { runId, path: reportPath, report: JSON.parse(raw) as RunReport };
  } catch {
    return undefined;
  }
}

export interface TaskMatch {
  stored: StoredReport;
  entry: RunReportTask;
}

/** Find a task id across all stored reports (a task id can recur across runs). */
export function findTaskAcrossReports(
  reports: StoredReport[],
  taskId: string,
): TaskMatch[] {
  const matches: TaskMatch[] = [];
  for (const stored of reports) {
    const entry = stored.report.tasks.find((t) => t.task.id === taskId);
    if (entry) matches.push({ stored, entry });
  }
  return matches;
}
