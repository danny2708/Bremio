import { Box, Text } from "ink";
import { useEffect, useState } from "react";
import { Header, Spinner, StatusText } from "../components";
import { AGENT_LABELS, formatAge, loadCapacity, type CapacityView } from "../data";
import { theme } from "../theme";

/** Horizontal meter for remaining capacity; unknown renders as a dim bar. */
function Meter({ percent }: { percent?: number }): React.JSX.Element {
  const width = 20;
  if (percent === undefined) {
    return <Text color={theme.muted}>{"░".repeat(width)} unknown</Text>;
  }
  const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)));
  const color = percent >= 50 ? theme.success : percent >= 20 ? theme.warning : theme.danger;
  return (
    <Text>
      <Text color={color}>{"█".repeat(filled)}</Text>
      <Text color={theme.muted}>{"░".repeat(width - filled)}</Text>
      <Text color={color}> {percent.toFixed(0)}%</Text>
    </Text>
  );
}

export function CapacityScreen(): React.JSX.Element {
  const [view, setView] = useState<CapacityView | undefined>();
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    try {
      setView(loadCapacity());
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  if (error) {
    return (
      <Box flexDirection="column">
        <Header title="Capacity" subtitle="read-only from AI-Quota-Tray" />
        <Text color={theme.danger}>✗ {error}</Text>
        <Text color={theme.muted}>
          Capacity needs AI-Quota-Tray running; Bremio never fetches provider quota itself.
        </Text>
      </Box>
    );
  }
  if (!view) {
    return (
      <Box flexDirection="column">
        <Header title="Capacity" subtitle="read-only from AI-Quota-Tray" />
        <Spinner label="reading quota database…" />
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Header title="Capacity" subtitle="read-only from AI-Quota-Tray" />
      {view.snapshots.map((snapshot) => {
        const age = formatAge(Math.max(0, view.readAt - snapshot.capturedAt));
        return (
          <Box key={snapshot.agentId} flexDirection="column" marginBottom={1}>
            <Box>
              <Text color={theme.primary} bold>
                {(AGENT_LABELS[snapshot.agentId] ?? snapshot.agentId).padEnd(14)}
              </Text>
              <StatusText status={snapshot.status} />
              <Text color={theme.muted}>
                {"  "}
                {snapshot.freshness} · {snapshot.confidence} confidence · {age} old
              </Text>
            </Box>
            {snapshot.windows.length === 0 ? (
              <Text color={theme.muted}>    no quota windows reported</Text>
            ) : (
              snapshot.windows.map((window) => (
                <Box key={window.id}>
                  <Text color={theme.muted}>{`    ${window.label.padEnd(22)}`}</Text>
                  <Meter {...(window.remainingPercent !== undefined
                    ? { percent: window.remainingPercent }
                    : {})} />
                </Box>
              ))
            )}
          </Box>
        );
      })}
      <Text color={theme.muted}>{`  source: ${view.databasePath}`}</Text>
    </Box>
  );
}
