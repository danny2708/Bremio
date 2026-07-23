import { Box, Text, useInput } from "ink";
import { useEffect, useState } from "react";
import { Header, Spinner, StatusText } from "../components";
import { theme } from "../theme";
import { loadSessionDetail, loadSessions } from "../data";
import { assembleTranscript } from "../transcript";
import { statusGlyph } from "../../ui";

export function RunsScreen({
  repoPath,
  onBack,
}: {
  repoPath: string;
  onBack?: () => void;
}): React.JSX.Element {
  const [sessions, setSessions] = useState<any[] | undefined>();
  const [selectedIndex, setSelectedIndex] = useState<number>(0);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);

  const [sessionData, setSessionData] = useState<
    { session: any; eventsMap: Map<string, any[]> } | undefined
  >();
  const [loadingSession, setLoadingSession] = useState<boolean>(false);
  const [expandAll, setExpandAll] = useState<boolean>(false);

  // Load session list on mount or when returning to list
  useEffect(() => {
    let alive = true;
    loadSessions(repoPath)
      .then((res) => {
        if (alive) setSessions(res);
      })
      .catch(() => {
        if (alive) setSessions([]);
      });
    return () => {
      alive = false;
    };
  }, [repoPath, selectedSessionId]);

  // Load session detail when a session is selected
  useEffect(() => {
    if (!selectedSessionId) {
      setSessionData(undefined);
      return;
    }

    let alive = true;
    setLoadingSession(true);

    const fetchDetail = () => {
      loadSessionDetail(selectedSessionId, repoPath)
        .then((res) => {
          if (alive) {
            setSessionData(res);
            setLoadingSession(false);
          }
        })
        .catch(() => {
          if (alive) setLoadingSession(false);
        });
    };

    fetchDetail();

    // Poll every 1s if the session might be live
    const interval = setInterval(() => {
      if (alive && selectedSessionId) {
        fetchDetail();
      }
    }, 1000);

    return () => {
      alive = false;
      clearInterval(interval);
    };
  }, [selectedSessionId, repoPath]);

  // Keyboard navigation
  useInput((input, key) => {
    if (selectedSessionId) {
      if (key.escape) {
        setSelectedSessionId(null);
        return;
      }
      if (input === "e" || input === " ") {
        setExpandAll((prev) => !prev);
        return;
      }
    } else {
      if (!sessions || sessions.length === 0) {
        if (key.escape && onBack) onBack();
        return;
      }
      if (key.upArrow || input === "k") {
        setSelectedIndex((prev) => Math.max(0, prev - 1));
      } else if (key.downArrow || input === "j") {
        setSelectedIndex((prev) => Math.min(sessions.length - 1, prev + 1));
      } else if (key.return && sessions[selectedIndex]) {
        setSelectedSessionId(sessions[selectedIndex].id);
      } else if (key.escape && onBack) {
        onBack();
      }
    }
  });

  if (!sessions) {
    return (
      <Box flexDirection="column">
        <Header title="Sessions" subtitle={repoPath} />
        <Spinner label="loading sessions…" />
      </Box>
    );
  }

  // Session Detail / Transcript View
  if (selectedSessionId) {
    if (loadingSession && !sessionData) {
      return (
        <Box flexDirection="column">
          <Header title="Session Transcript" subtitle={selectedSessionId} />
          <Spinner label={`loading transcript for ${selectedSessionId}…`} />
        </Box>
      );
    }

    if (!sessionData || !sessionData.session) {
      return (
        <Box flexDirection="column">
          <Header title="Session Transcript" subtitle={selectedSessionId} />
          <Text color={theme.danger}>  error: session not found or empty</Text>
          <Text color={theme.muted}>  press [esc] to return to session list</Text>
        </Box>
      );
    }

    const viewModel = assembleTranscript(sessionData.session, sessionData.eventsMap);

    return (
      <Box flexDirection="column">
        <Header
          title={`Session: ${viewModel.title || viewModel.sessionId}`}
          subtitle={`${viewModel.sessionId} · ${viewModel.repositoryPath}`}
        />
        <Box flexDirection="column" marginY={1}>
          <Text color={theme.accent}>
            {`  [Keyboard] press 'e' or space to ${expandAll ? "collapse" : "expand"} reasoning & tool calls | esc to return`}
          </Text>
        </Box>

        {viewModel.turns.length === 0 ? (
          <Text color={theme.muted}>  no turns recorded in this session</Text>
        ) : (
          viewModel.turns.map((turn) => (
            <Box key={turn.runId} flexDirection="column" marginBottom={1}>
              {/* The prompt reads as something the user said, so it is
                  attributed and quoted rather than labelled "Prompt:". */}
              <Text bold color={theme.accent}>{"  You"}</Text>
              {turn.prompt.split("\n").map((line, idx) => (
                <Text key={idx} color={theme.text}>{`    ${line}`}</Text>
              ))}

              <Box marginTop={1} />
              <Text bold color={theme.primary}>
                {`  ${turn.model ?? "Agent"}`}
                {turn.reasoningLevel ? (
                  <Text color={theme.muted}>{` · ${turn.reasoningLevel}`}</Text>
                ) : null}
              </Text>

              {/* The work comes before the answer, dimmed and collapsed, the
                  way every other agent CLI orders it. */}
              {turn.events.length > 0 ? (
                <Box flexDirection="column">
                  {turn.events
                    .filter((ev) => ev.kind !== "message" && ev.kind !== "completed")
                    .map((ev, idx) => {
                      if (ev.isCollapsible && !expandAll) {
                        return (
                          <Text key={`${ev.seq}-${idx}`} color={theme.muted}>
                            {`    ▸ ${ev.summary}`}
                          </Text>
                        );
                      }
                      return (
                        <Box key={`${ev.seq}-${idx}`} flexDirection="column">
                          <Text color={ev.severity === "error" ? theme.danger : theme.muted}>
                            {`    ${ev.isCollapsible ? "▾" : "·"} ${ev.summary}`}
                          </Text>
                          {ev.detail ? (
                            <Text color={theme.muted}>{`      ${ev.detail}`}</Text>
                          ) : null}
                        </Box>
                      );
                    })}
                </Box>
              ) : null}

              {/* The answer itself, at full width and undimmed: this is the
                  part the user came for, and it used to be invisible. */}
              {turn.response ? (
                <Box flexDirection="column" marginTop={turn.events.length > 0 ? 1 : 0}>
                  {turn.response.split("\n").map((line, idx) => (
                    <Text key={idx} color={theme.text}>{`    ${line}`}</Text>
                  ))}
                </Box>
              ) : (
                <Text color={theme.muted}>{"    (no response recorded)"}</Text>
              )}

              <Box marginTop={1}>
                <Text color={theme.muted}>
                  {`    ${statusGlyph(turn.status as any)} ${turn.status} · run ${turn.runId}`}
                </Text>
              </Box>
            </Box>
          ))
        )}
      </Box>
    );
  }

  // Session List View
  return (
    <Box flexDirection="column">
      <Header title="Sessions" subtitle={`${repoPath} · newest first`} />
      <Box marginBottom={1}>
        <Text color={theme.muted}>
          {"  ↑↓ navigate  enter open transcript  esc back"}
        </Text>
      </Box>
      {sessions.length === 0 ? (
        <Text color={theme.muted}>  no sessions recorded in this repository yet</Text>
      ) : (
        sessions.slice(0, 15).map((s, idx) => {
          const isSelected = idx === selectedIndex;
          const turnsText = `${s.turnCount ?? 1} turn${(s.turnCount ?? 1) === 1 ? "" : "s"}`;
          const updated = s.updatedAt ? new Date(s.updatedAt).toLocaleTimeString() : "";

          return (
            <Box key={s.id}>
              <Text color={isSelected ? theme.accent : theme.muted}>
                {isSelected ? "❯ " : "  "}
              </Text>
              <Text bold={isSelected} color={isSelected ? theme.accent : theme.primary}>
                {`${s.id}  `}
              </Text>
              <Text bold={isSelected} color={isSelected ? theme.text : theme.textSecondary}>
                {`${(s.title || "Untitled").slice(0, 40)}  `}
              </Text>
              <Text color={theme.muted}>{`[${turnsText}]  `}</Text>
              <StatusText status={s.status ?? "completed"} />
              <Text color={theme.muted}>{`  ${updated}`}</Text>
            </Box>
          );
        })
      )}
    </Box>
  );
}
