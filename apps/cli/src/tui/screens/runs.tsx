import { Box, Text } from "ink";
import { useEffect, useState } from "react";
import { Header, Spinner, StatusText } from "../components";
import { listReports, type StoredReport } from "@bremio/orchestrator";
import { theme } from "../theme";

function summarize(stored: StoredReport): { status: string; detail: string } {
  const report = stored.report;
  if (report.mode === "single") {
    return {
      status: report.result.status,
      detail: `single · ${report.primaryAgentId} · ${report.result.filesChanged.length} file(s)`,
    };
  }
  const s = report.summary;
  const status = s.failed > 0 ? "failed" : s.cancelled > 0 ? "cancelled" : "completed";
  return {
    status,
    detail: `team · lead ${report.leadAgentId} · ${s.completed}/${s.total} tasks · ${s.filesChanged} file(s)`,
  };
}

export function RunsScreen({ repoPath }: { repoPath: string }): React.JSX.Element {
  const [reports, setReports] = useState<StoredReport[] | undefined>();

  useEffect(() => {
    let alive = true;
    listReports(repoPath)
      .then((result) => {
        if (alive) setReports(result);
      })
      .catch(() => {
        if (alive) setReports([]);
      });
    return () => {
      alive = false;
    };
  }, [repoPath]);

  if (!reports) {
    return (
      <Box flexDirection="column">
        <Header title="Runs" subtitle={repoPath} />
        <Spinner label="reading .bremio/runs…" />
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Header title="Runs" subtitle={`${repoPath} · newest first`} />
      {reports.length === 0 ? (
        <Text color={theme.muted}>  no runs recorded in this repository yet</Text>
      ) : (
        reports.slice(0, 15).map((stored) => {
          const { status, detail } = summarize(stored);
          return (
            <Box key={stored.runId}>
              <Text color={theme.primary}>{`  ${stored.runId}  `}</Text>
              <StatusText status={status} />
              <Text color={theme.muted}>{`  ${detail}`}</Text>
            </Box>
          );
        })
      )}
    </Box>
  );
}
