import { Box, Text, useInput } from "ink";
import { useCallback, useEffect, useState } from "react";
import type { AqtServiceStatus } from "@bremio/quota";
import { Header, Spinner, StatusText } from "../components";
import { AGENT_LABELS, formatAge, loadLiveCapacity, type CapacityView } from "../data";
import { theme } from "../theme";

/** How often to re-ask AI-Quota-Tray while this screen is open. */
const LIVE_INTERVAL_MS = 30_000;

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

/**
 * State the liveness of the source before any number. Without it, days-old
 * values read as current.
 */
function SourceBanner({ service }: { service?: AqtServiceStatus }): React.JSX.Element | null {
  if (!service) return null;
  if (service.state === "live") {
    return (
      <Text color={theme.success}>
        ● LIVE — AI-Quota-Tray responding{service.version ? ` (v${service.version})` : ""}
      </Text>
    );
  }
  const reason = service.state === "stale-endpoint"
    ? "published an endpoint but is not responding"
    : "is not running";
  return (
    <Box flexDirection="column">
      <Text color={theme.warning}>○ NOT LIVE — AI-Quota-Tray {reason}.</Text>
      <Text color={theme.muted}>
        {"  "}Values below are last-known, not current. Start AI-Quota-Tray for live capacity.
      </Text>
    </Box>
  );
}

export function CapacityScreen(): React.JSX.Element {
  const [view, setView] = useState<CapacityView | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      setView(await loadLiveCapacity());
      setError(undefined);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), LIVE_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [load]);

  useInput((input) => {
    if (input === "r") void load();
  });

  if (error) {
    return (
      <Box flexDirection="column">
        <Header title="Capacity" subtitle="live through AI-Quota-Tray" />
        <Text color={theme.danger}>✗ {error}</Text>
        <Text color={theme.muted}>
          Capacity needs AI-Quota-Tray; Bremio never fetches provider quota itself.
        </Text>
      </Box>
    );
  }
  if (!view) {
    return (
      <Box flexDirection="column">
        <Header title="Capacity" subtitle="live through AI-Quota-Tray" />
        <Spinner label="asking AI-Quota-Tray to refresh…" />
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Header title="Capacity" subtitle="live through AI-Quota-Tray" />
      <SourceBanner {...(view.service ? { service: view.service } : {})} />
      <Box marginBottom={1} />
      {view.snapshots.map((snapshot) => {
        const age = formatAge(Math.max(0, view.readAt - snapshot.lastContactAt));
        return (
          <Box key={snapshot.agentId} flexDirection="column" marginBottom={1}>
            {/* Two rows, not one: a single flex row overflowed narrow
                terminals and Ink truncated the status word itself, so
                "unknown" rendered as "unknow". */}
            <Box>
              <Text color={theme.primary} bold>
                {(AGENT_LABELS[snapshot.agentId] ?? snapshot.agentId).padEnd(14)}
              </Text>
              <StatusText status={snapshot.status} />
            </Box>
            <Text color={theme.muted}>
              {"    "}contact {snapshot.contactFreshness} {age} ago ·{" "}
              {snapshot.confidence} confidence in the numbers
            </Text>
            {snapshot.source.confidenceLabel === "unavailable" ? (
              <Text color={theme.warning}>    SOURCE UNAVAILABLE — no data from AI-Quota-Tray</Text>
            ) : null}
            {snapshot.windows.length === 0 ? (
              <Text color={theme.muted}>    no quota windows reported</Text>
            ) : (
              snapshot.windows.map((window) => (
                <Box key={window.id}>
                  <Text color={theme.muted}>{`    ${window.label.slice(0, 22).padEnd(23)}`}</Text>
                  <Meter {...(window.remainingPercent !== undefined
                    ? { percent: window.remainingPercent }
                    : {})} />
                  {/* Each window's own data age, which the provider line
                      cannot convey: a source can be reachable while the
                      numbers under it are days old. */}
                  <Text color={window.freshness === "fresh" ? theme.muted : theme.warning}>
                    {"  "}
                    {formatAge(Math.max(0, view.readAt - window.capturedAt))} old
                    {window.freshness === "fresh" ? "" : ` (${window.freshness})`}
                  </Text>
                </Box>
              ))
            )}
          </Box>
        );
      })}
      <Text color={theme.muted}>
        {refreshing ? "  refreshing…" : `  press r to refresh · auto every ${LIVE_INTERVAL_MS / 1000}s`}
      </Text>
      <Text color={theme.muted}>{`  source: ${view.databasePath}`}</Text>
    </Box>
  );
}
