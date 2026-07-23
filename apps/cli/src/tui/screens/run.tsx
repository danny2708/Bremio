import { Box, Text, useInput } from "ink";
import { useCallback, useRef, useState } from "react";
import {
  DEFAULT_MAX_CONCURRENCY,
  createRegistry,
  runBremio,
  runSingleAgent,
  type BremioRunReport,
} from "@bremio/orchestrator";
import type { AgentEvent } from "@bremio/protocol";
import { ErrorBox, Header, Menu, Spinner, StatusText, TextInput } from "../components";
import { createAdapters, AGENT_LABELS } from "../data";
import { theme } from "../theme";

type Phase = "mode" | "agent" | "prompt" | "running" | "done";
type Mode = "single" | "team";

const MAX_LINES = 12;

/** Render an event as one activity line, or skip it. */
function describeEvent(event: AgentEvent): string | undefined {
  const clip = (s: string, n = 90) => {
    const one = s.replace(/\s+/g, " ").trim();
    return one.length > n ? `${one.slice(0, n)}…` : one;
  };
  switch (event.type) {
    case "message":
      return clip(event.text);
    case "thinking":
      return `· ${clip(event.text, 70)}`;
    case "tool_use": {
      const input = event.input as { command?: unknown; file_path?: unknown } | undefined;
      const arg =
        typeof input?.command === "string"
          ? input.command
          : typeof input?.file_path === "string"
            ? input.file_path
            : "";
      return `⚙ ${event.name}${arg ? ` ${clip(String(arg), 60)}` : ""}`;
    }
    case "tool_result":
      return `${event.ok ? "✓" : "✗"} ${event.name}`;
    case "error":
      return `✗ ${clip(event.message)}`;
    default:
      return undefined;
  }
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
  const [agentId, setAgentId] = useState<string>("claude");
  const [prompt, setPrompt] = useState("");
  const [lines, setLines] = useState<string[]>([]);
  const [status, setStatus] = useState("starting");
  const [report, setReport] = useState<BremioRunReport | undefined>();
  const [error, setError] = useState<string | undefined>();
  const abortRef = useRef<AbortController | undefined>(undefined);

  const push = useCallback((line: string | undefined) => {
    if (!line) return;
    setLines((prev) => [...prev, line].slice(-MAX_LINES));
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
              if (dirty.length) push(`⚠ ${dirty.length} uncommitted file(s) already in the workspace`);
            },
            onStart: (id) => push(`▶ ${id} started`),
            onEvent: (event) => push(describeEvent(event)),
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
            onLeadStart: (id) => push(`▶ lead ${id} planning…`),
            onLeadEvent: (event) => push(describeEvent(event)),
            onPlan: (plan) => {
              setStatus(`executing ${plan.tasks.length} task(s), up to ${DEFAULT_MAX_CONCURRENCY} at a time`);
              push(`✓ plan: ${plan.summary}`);
            },
            onFallback: (reason, id) => {
              setStatus(`falling back to Single Agent ${AGENT_LABELS[id] ?? id}`);
              push(`⚠ ${reason}`);
            },
            onTaskStart: (task, id) => push(`▶ ${task.id} ${task.title} → ${id}`),
            // Independent tasks run concurrently, so each line names its task.
            onEvent: (task, _id, event) => push(`[${task.id}] ${describeEvent(event)}`),
            onTaskComplete: (taskResult) =>
              push(`${taskResult.status === "completed" ? "✓" : "✗"} ${taskResult.taskId} ${taskResult.status}`),
          },
        });
      }
      setReport(result);
      setPhase("done");
    } catch (err) {
      setError((err as Error).message);
      setPhase("done");
    }
  }, [agentId, mode, prompt, push, repoPath]);

  useInput(
    (_input, key) => {
      if (key.escape) {
        if (phase === "running") abortRef.current?.abort();
        else onExit();
      }
    },
    { isActive: phase !== "prompt" },
  );

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
    // Antigravity emits no structured plan, so it can implement but never lead.
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
          {lines.map((line, i) => (
            <Text key={`${i}-${line.slice(0, 12)}`} color={theme.muted}>
              {"  "}
              {line}
            </Text>
          ))}
        </Box>
        <Text color={theme.muted}>{"\n  esc to cancel"}</Text>
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
