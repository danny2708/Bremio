import { Box, Text, useInput } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  DEFAULT_MAX_CONCURRENCY,
  createRegistry,
  ledgerPathFor,
  readLedger,
  resolveAutoMode,
  runBremio,
  runSingleAgent,
  type BremioRunReport,
} from "@bremio/orchestrator";
import { assembleTaskLanes, renderEvent, type LaneTask } from "@bremio/event-view";
import { ErrorBox, Header, Menu, Spinner, StatusText, TextInput } from "../components";
import { createAdapters, AGENT_LABELS } from "../data";
import { theme } from "../theme";

type Phase = "mode" | "agent" | "worker" | "prompt" | "running" | "done";
type Mode = "single" | "team";
/** What the user picked, which is not the same as what will run under `auto`. */
type ModeChoice = Mode | "auto";

export interface AgentChoice {
  id: string;
  leadEligible: boolean;
  hint?: string;
}

/**
 * The agents the picker offers, and which of them may lead.
 *
 * Derived from each adapter's declared capabilities so the TUI cannot drift
 * from the CLI: a provider added to `createAdapters` appears here without
 * anyone remembering to edit a list, and one that loses `structuredOutput`
 * stops being offered as a lead on its own.
 */
export function buildAgentChoices(
  adapters: ReadonlyArray<{ id: string; capabilities: { planning: boolean; structuredOutput: boolean } }>,
): AgentChoice[] {
  return adapters.map((adapter) => ({
    id: adapter.id,
    leadEligible: adapter.capabilities.planning && adapter.capabilities.structuredOutput,
  }));
}

/**
 * The one-line description of what is about to run, or is running.
 *
 * Under `auto` the chosen mode is shown alongside the fact that auto chose it,
 * so the run is never described only as "auto" — the user has to be able to see
 * whether Single or Team was actually selected.
 */
export function describeSelection(selection: {
  modeChoice: ModeChoice;
  mode: Mode;
  agentId: string;
  workerId?: string;
}): string {
  const label = (id: string): string => AGENT_LABELS[id] ?? id;
  const modeText = selection.modeChoice === "auto" ? `auto → ${selection.mode}` : selection.mode;
  const agents =
    selection.mode === "team" && selection.workerId
      ? `${label(selection.agentId)} → ${label(selection.workerId)}`
      : label(selection.agentId);
  return `${modeText} · ${agents}`;
}

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
  const [modeChoice, setModeChoice] = useState<ModeChoice>("single");
  const [autoReason, setAutoReason] = useState<string | undefined>(undefined);
  const [agentId, setAgentId] = useState<string>("claude");
  const [workerId, setWorkerId] = useState<string | undefined>(undefined);
  const [prompt, setPrompt] = useState("");
  const [events, setEvents] = useState<Array<{ kind?: string; taskId?: string; agentId?: string; message?: string; data?: unknown }>>([]);
  const [expandedLane, setExpandedLane] = useState<string | undefined>(undefined);
  const [status, setStatus] = useState("starting");
  const [report, setReport] = useState<BremioRunReport | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [agentChoices, setAgentChoices] = useState<AgentChoice[]>([]);
  const abortRef = useRef<AbortController | undefined>(undefined);

  // Capabilities are read once, on mount: a picker that has to wait for four
  // adapter probes on every keystroke would be unusable.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const choices = await Promise.all(
        createAdapters().map(async (adapter) => ({
          id: adapter.id,
          capabilities: await adapter.getCapabilities(),
        })),
      );
      if (!cancelled) setAgentChoices(buildAgentChoices(choices));
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const pushEv = useCallback((ev: { kind?: string; taskId?: string; agentId?: string; message?: string; data?: unknown }) => {
    setEvents((prev) => [...prev, ev]);
  }, []);

  /**
   * Resolve `auto` the same way `bremio run --mode auto` does, from this
   * repository's ledger. The decision and its reason are shown before the run
   * starts rather than only in the report: the point of auto mode is that the
   * user can see why it chose what it chose.
   */
  const resolveAuto = useCallback(async () => {
    let resolved: Mode = "single";
    let reason: string;
    try {
      const entries = await readLedger(ledgerPathFor(repoPath));
      const result = resolveAutoMode(entries);
      resolved = result.mode;
      reason = result.reason;
    } catch (err) {
      // Fail closed to Single, and say so. An unreadable ledger is not
      // evidence that Team is worth it.
      reason = `auto selected Single — could not read the ledger (${(err as Error).message})`;
    }
    setMode(resolved);
    setAutoReason(reason);
    setPhase("agent");
  }, [repoPath]);

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
          ...(workerId ? { workerId } : {}),
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
  }, [agentId, mode, prompt, pushEv, repoPath, workerId]);

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
            { key: "auto", label: "Auto", hint: "decide from calibration evidence in this repo" },
          ]}
          onSelect={(key) => {
            setModeChoice(key as ModeChoice);
            setAgentId("claude");
            setWorkerId(undefined);
            if (key === "auto") {
              void resolveAuto();
              return;
            }
            setMode(key as Mode);
            setAutoReason(undefined);
            setPhase("agent");
          }}
        />
      </Box>
    );
  }

  if (phase === "agent") {
    // Lead eligibility is a capability question, not a list of names: an agent
    // that cannot return a structured plan cannot lead, whoever it is.
    const items = agentChoices
      .filter((choice) => (mode === "team" ? choice.leadEligible : true))
      .map((choice) => ({
        key: choice.id,
        label: AGENT_LABELS[choice.id] ?? choice.id,
        ...(choice.hint ? { hint: choice.hint } : {}),
      }));
    return (
      <Box flexDirection="column">
        <Header
          title={mode === "single" ? "Choose agent" : "Choose lead"}
          subtitle={autoReason ?? (mode === "team" ? "plans the work" : undefined)}
        />
        <Menu
          items={items}
          onSelect={(key) => {
            setAgentId(key);
            setPhase(mode === "team" ? "worker" : "prompt");
          }}
        />
      </Box>
    );
  }

  if (phase === "worker") {
    // A worker only has to execute, so lead eligibility is irrelevant here —
    // this is where OpenCode and Antigravity become selectable, which the CLI
    // already allowed via --worker and the TUI simply never offered.
    const items = agentChoices
      .filter((choice) => choice.id !== agentId)
      .map((choice) => ({
        key: choice.id,
        label: AGENT_LABELS[choice.id] ?? choice.id,
        ...(choice.hint ? { hint: choice.hint } : {}),
      }));
    return (
      <Box flexDirection="column">
        <Header title="Choose worker" subtitle={`executes in git worktrees · lead is ${AGENT_LABELS[agentId] ?? agentId}`} />
        <Menu
          items={items}
          onSelect={(key) => {
            setWorkerId(key);
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
          subtitle={describeSelection({ modeChoice, mode, agentId, ...(workerId ? { workerId } : {}) })}
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
        <Header title="Running" subtitle={describeSelection({ modeChoice, mode, agentId, ...(workerId ? { workerId } : {}) })} />
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
      <Header title="Result" subtitle={describeSelection({ modeChoice, mode, agentId, ...(workerId ? { workerId } : {}) })} />
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
