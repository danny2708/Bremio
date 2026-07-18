import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  BremioRunReport,
  RunReport,
  RunReportTask,
} from "./aggregator";

export interface StoredReport {
  runId: string;
  path: string;
  report: BremioRunReport;
}

export interface StoredTeamReport extends StoredReport {
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
      reports.push({ runId, path: reportPath, report: parseReport(raw) });
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
    return { runId, path: reportPath, report: parseReport(raw) };
  } catch {
    return undefined;
  }
}

export interface TaskMatch {
  stored: StoredTeamReport;
  entry: RunReportTask;
}

/** Find a task id across all stored reports (a task id can recur across runs). */
export function findTaskAcrossReports(
  reports: StoredReport[],
  taskId: string,
): TaskMatch[] {
  const matches: TaskMatch[] = [];
  for (const stored of reports) {
    if (stored.report.mode !== "team") continue;
    const entry = stored.report.tasks.find((t) => t.task.id === taskId);
    if (entry) {
      matches.push({
        stored: { ...stored, report: stored.report },
        entry,
      });
    }
  }
  return matches;
}

/** Legacy reports predate the mode discriminator and are all Team reports. */
function parseReport(raw: string): BremioRunReport {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  if (parsed.mode === "single") return parsed as unknown as BremioRunReport;
  if (parsed.mode === "team") return parsed as unknown as RunReport;
  if (!("mode" in parsed)) {
    return { ...parsed, mode: "team" } as unknown as RunReport;
  }
  throw new Error(`unsupported Bremio report mode: ${String(parsed.mode)}`);
}
