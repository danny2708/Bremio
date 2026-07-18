import { Box, Text } from "ink";
import { useEffect, useState } from "react";
import { Header, Spinner, StatusText } from "../components";
import { AGENT_LABELS, loadDiagnostics, type AgentDiagnostic } from "../data";
import { theme } from "../theme";

export function DoctorScreen(): React.JSX.Element {
  const [rows, setRows] = useState<AgentDiagnostic[] | undefined>();
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let alive = true;
    loadDiagnostics()
      .then((result) => {
        if (alive) setRows(result);
      })
      .catch((err: unknown) => {
        if (alive) setError((err as Error).message);
      });
    return () => {
      alive = false;
    };
  }, []);

  if (error) return <Text color={theme.danger}>✗ {error}</Text>;
  if (!rows) {
    return (
      <Box flexDirection="column">
        <Header title="Doctor" subtitle="adapter health and lead eligibility" />
        <Spinner label="probing adapters…" />
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Header title="Doctor" subtitle="adapter health and lead eligibility" />
      {rows.map((row) => (
        <Box key={row.id} flexDirection="column" marginBottom={1}>
          <Box>
            <Text color={theme.primary} bold>
              {(AGENT_LABELS[row.id] ?? row.id).padEnd(14)}
            </Text>
            <StatusText status={row.health.status} />
          </Box>
          {row.health.detail ? (
            <Text color={theme.muted}>    {row.health.detail}</Text>
          ) : null}
          <Text color={theme.muted}>
            {"    lead-eligible: "}
            <Text color={row.leadEligible ? theme.success : theme.muted}>
              {row.leadEligible ? "yes" : "no"}
            </Text>
            {`  (planning=${row.capabilities.planning}, structuredOutput=${row.capabilities.structuredOutput})`}
          </Text>
          <Text color={theme.muted}>
            {`    write=${row.capabilities.repositoryWrite}  shell=${row.capabilities.shell}  test-gate=${row.capabilities.testing}`}
          </Text>
        </Box>
      ))}
    </Box>
  );
}
