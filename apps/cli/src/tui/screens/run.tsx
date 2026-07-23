import { Box, Text, useInput } from "ink";
import { useCallback, useRef, useState } from "react";
import {
  DEFAULT_MAX_CONCURRENCY,
  createRegistry,
  runBremio,
  runSingleAgent,
  type BremioRunReport,
} from "@bremio/orchestrator";
import { assembleTaskLanes, renderEvent, type LaneTask } from "@bremio/event-view";
import { ErrorBox, Header, Menu, Spinner, StatusText, TextInput } from "../components";
import { createAdapters, AGENT_LABELS } from "../data";
import { theme } from "../theme";

type Phase = "mode" | "agent" | "prompt" | "running" | "done";
type Mode = "single" | "team";

function reportStatus(report: BremioRunReport): string {
  if (report.mode === "single") return report.result.status;
  return report.summary.failed > 0
    ? "failed"
    : report.summary.cancelled > 0
      ? "cancelled"
      : "completed";
}

export function RunScreen({
  repoPath,
  onExit,
}: {
  repoPath: string;
  onExit: () => void;
}): React.JSX.Element {
  const [phase, setPhase] = useState<Phase>("mode");
  const [mode, setMode] = useState<Mode>("single");
  const [agentId, setAgentId] = useState<string>("claude");
  const [prompt, setPrompt] = useState("");
  const [events, setEvents] = useState<Array<{ kind?: string; taskId?: string; agentId?: string; message?: string; data?: unknown }>>([]);
  const [expandedLane, setExpandedLane] = useState<string | undefined>(undefined);
  const [status, setStatus] = useState("starting");
  const [report, setReport] = useState<BremioRunReport | undefined>();
  const [error, setError] = useState<string | undefined>();
  const abortRef = useRef<AbortController | undefined>(undefined);

  const pushEv = useCallback((ev: { kind?: string; taskId?: string; agentId?: string; message?: string; data?: unknown }) => {
    setEvents((prev) => [...prev, ev]);
  }, []);

  const start = useCallback(async () => {
    setPhase("running");
    const registry = createRegistry(createAdapters());
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      let result: BremioRunReport;
      if (mode === "single") {
        setStatus(`${AGENT_LABELS[agentId] ?? agentId} working directly in the repo`);
        result = await runSingleAgent({
          primaryAgentId: agentId,
          repoPath,
          prompt,
          registry,
          signal: controller.signal,
          hooks: {
            onWorkspaceReady: (dirty) => {
              if (dirty.length) pushEv({ kind: "log", taskId: "MAIN", agentId, message: `⚠ ${dirty.length} uncommitted file(s) already in workspace` });
            },
            onStart: (id) => pushEv({ kind: "started", taskId: "MAIN", agentId: id, message: `${id} started` }),
            onEvent: (event) => pushEv({ kind: (event as any)?.type || "log", taskId: "MAIN", agentId, data: event }),
          },
        });
      } else {
        setStatus(`${AGENT_LABELS[agentId] ?? agentId} is planning`);
        result = await runBremio({
          leadId: agentId,
          repoPath,
          prompt,
          registry,
          signal: controller.signal,
          hooks: {
            onLeadStart: (id) => pushEv({ kind: "lead", taskId: "LEAD", agentId: id, message: `lead ${id} planning…` }),
            onLeadEvent: (event) => pushEv({ kind: (event as any)?.type || "lead", taskId: "LEAD", agentId, data: event }),
            onPlan: (plan) => {
              setStatus(`executing ${plan.tasks.length} task(s), up to ${DEFAULT_MAX_CONCURRENCY} at a time`);
              pushEv({ kind: "plan", taskId: "LEAD", agentId, data: { plan } });
            },
            onFallback: (reason, id) => {
              setStatus(`falling back to Single Agent ${AGENT_LABELS[id] ?? id}`);
              pushEv({ kind: "failed", taskId: "LEAD", agentId: id, message: `Fallback: ${reason}` });
            },
            onTaskStart: (task, id) => pushEv({ kind: "task-start", taskId: task.id, agentId: id, message: task.title }),
            onEvent: (task, id, event) => pushEv({ kind: (event as any)?.type || "task-event", taskId: task.id, agentId: id, data: event }),
            onTaskComplete: (taskResult) =>
              pushEv({ kind: "task-complete", taskId: taskResult.taskId, message: taskResult.status }),
          },
        });
      }
      setReport(result);
      setPhase("done");
    } catch (err) {
      setError((err as Error).message);
      setPhase("done");
    }
  }, [agentId, mode, prompt, pushEv, repoPath]);

  useInput(
    (input, key) => {
      if (key.escape) {
        if (phase === "running") abortRef.current?.abort();
        else onExit();
      }
      if (phase === "running" && input === "e") {
        const lanes = assembleTaskLanes(events);
        if (lanes.length && lanes[0]) {
          setExpandedLane((prev) => (prev ? undefined : lanes[0]!.id));
        }
      }
    },
    { isActive: phase !== "prompt" },
  );

  const lanes = assembleTaskLanes(events);

  if (phase === "mode") {
    return (
      <Box flexDirection="column">
        <Header title="New run" subtitle={repoPath} />
        <Menu
          items={[
            { key: "single", label: "Single Agent", hint: "one agent, directly in this workspace" },
            { key: "team", label: "Team", hint: "lead plans, worker executes in git worktrees" },
          ]}
          onSelect={(key) => {
            setMode(key as Mode);
            setAgentId(key === "team" ? "claude" : "claude");
            setPhase("agent");
          }}
        />
      </Box>
    );
  }

  if (phase === "agent") {
    const items =
      mode === "single"
        ? [
            { key: "claude", label: "Claude" },
            { key: "codex", label: "Codex" },
            { key: "antigravity", label: "Antigravity", hint: "subscription quota via agy" },
          ]
        : [
            { key: "claude", label: "Claude", hint: "lead" },
            { key: "codex", label: "Codex", hint: "lead" },
          ];
    return (
      <Box flexDirection="column">
        <Header
          title={mode === "single" ? "Choose agent" : "Choose lead"}
          subtitle={mode === "team" ? "the other agent becomes the worker" : undefined}
        />
        <Menu
          items={items}
          onSelect={(key) => {
            setAgentId(key);
            setPhase("prompt");
          }}
        />
      </Box>
    );
  }

  if (phase === "prompt") {
    return (
      <Box flexDirection="column">
        <Header
          title="Prompt"
          subtitle={`${mode === "single" ? "single" : "team"} · ${AGENT_LABELS[agentId] ?? agentId}`}
        />
        <TextInput
          value={prompt}
          onChange={setPrompt}
          onSubmit={() => {
            if (prompt.trim()) void start();
          }}
          placeholder="describe the change you want…"
        />
        <Text color={theme.muted}>  enter to run</Text>
      </Box>
    );
  }

  if (phase === "running") {
    return (
      <Box flexDirection="column">
        <Header title="Running" subtitle={`${mode} · ${AGENT_LABELS[agentId] ?? agentId}`} />
        <Spinner label={status} />
        <Box flexDirection="column" marginTop={1}>
          {lanes.map((lane) => {
            const isExpanded = expandedLane === lane.id;
            const statusGlyph =
              lane.status === "completed" ? "✓" : lane.status === "failed" ? "✗" : "▶";
            const statusColor =
              lane.status === "completed"
                ? theme.success
                : lane.status === "failed"
                  ? theme.warning
                  : theme.accent;

            return (
              <Box key={lane.id} flexDirection="column" marginBottom={0}>
                <Text color={statusColor}>
                  {`  ${statusGlyph} ${lane.id} (${lane.agentId ?? "agent"}) — ${lane.title}: ${lane.lastActivity}`}
                </Text>
                {isExpanded
                  ? lane.events.map((ev, idx) => (
                      <Text key={idx} color={theme.muted}>
                        {`    ${ev.summary}`}
                      </Text>
                    ))
                  : null}
              </Box>
            );
          })}
        </Box>
        <Text color={theme.muted}>{"\n  press 'e' to toggle lane expansion  ·  esc to cancel"}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Header title="Result" subtitle={`${mode} · ${AGENT_LABELS[agentId] ?? agentId}`} />
      {error ? <ErrorBox message={error} /> : null}
      {report ? (
        <Box flexDirection="column">
          <Box>
            <Text color={theme.muted}>{"  status: "}</Text>
            <StatusText status={reportStatus(report)} />
          </Box>
          {report.mode === "single" ? (
            <>
              {report.fallback ? (
                <Text color={theme.warning}>{`  Team fallback: ${report.fallback.reason}`}</Text>
              ) : null}
              <Text color={theme.muted}>
                {`  files: ${report.result.filesChanged.length}  ·  verification: ${report.verification.status}`}
              </Text>
              {report.result.filesChanged.length ? (
                <Text color={theme.muted}>{`  changed: ${report.result.filesChanged.join(", ")}`}</Text>
              ) : null}
            </>
          ) : (
            <>
              {report.autoModeReason ? (
                <Text color={theme.muted}>{`  auto mode: ${report.autoModeReason}`}</Text>
              ) : null}
              <Text color={theme.muted}>
                {`  tasks: ${report.summary.completed}/${report.summary.total} completed  ·  files: ${report.summary.filesChanged}`}
              </Text>
              <Text color={theme.muted}>
                {`  quality gate: ${report.qualityGate.status}  ·  merge with: bremio merge <taskId>`}
              </Text>
            </>
          )}
          <Text color={theme.muted}>{`  report: ${report.runDir}`}</Text>
        </Box>
      ) : null}
      <Text color={theme.muted}>{"\n  esc to go back"}</Text>
    </Box>
  );
}
