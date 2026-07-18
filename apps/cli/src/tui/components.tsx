import { Box, Text, useInput } from "ink";
import { useEffect, useState } from "react";
import { colorForAgent, colorForTone, glyphForStatus, theme, toneForStatus } from "./theme";

/** The Bremio wordmark. Kept small so it never dominates a short terminal. */
export function Banner({ version }: { version: string }): React.JSX.Element {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={theme.primary} bold>
        ██████╗ ██████╗ ███████╗███╗   ███╗██╗ ██████╗
      </Text>
      <Text color={theme.primary} bold>
        ██╔══██╗██╔══██╗██╔════╝████╗ ████║██║██╔═══██╗
      </Text>
      <Text color={theme.primary} bold>
        ██████╔╝██████╔╝█████╗  ██╔████╔██║██║██║   ██║
      </Text>
      <Text color={theme.primaryActive}>
        ██╔══██╗██╔══██╗██╔══╝  ██║╚██╔╝██║██║██║   ██║
      </Text>
      <Text color={theme.primaryActive}>
        ██████╔╝██║  ██║███████╗██║ ╚═╝ ██║██║╚██████╔╝
      </Text>
      <Text color={theme.muted}>
        Different minds. One team. <Text color={theme.muted}>v{version}</Text>
      </Text>
    </Box>
  );
}

export function Header({ title, subtitle }: { title: string; subtitle?: string }): React.JSX.Element {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={theme.primary} bold>
        ▎{title}
      </Text>
      {subtitle ? <Text color={theme.muted}>  {subtitle}</Text> : null}
    </Box>
  );
}

export function Footer({ hints }: { hints: string[] }): React.JSX.Element {
  return (
    <Box marginTop={1}>
      <Text color={theme.muted}>{hints.join("   ")}</Text>
    </Box>
  );
}

/** Status word with a matching glyph and colour. */
export function StatusText({ status }: { status: string }): React.JSX.Element {
  const color = colorForTone(toneForStatus(status));
  return (
    <Text color={color}>
      {glyphForStatus(status)} {status}
    </Text>
  );
}

/** Provider name in its own identity colour, so agents stay distinguishable. */
export function AgentName({ agentId, label }: { agentId: string; label?: string }): React.JSX.Element {
  return <Text color={colorForAgent(agentId)}>{label ?? agentId}</Text>;
}

/** Yellow marks the lead role — the one agent steering the run. */
export function LeadBadge(): React.JSX.Element {
  return <Text color={theme.accent} bold> LEAD </Text>;
}

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Minimal spinner — avoids pulling in another dependency. */
export function Spinner({ label }: { label?: string }): React.JSX.Element {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setFrame((f) => (f + 1) % FRAMES.length), 80);
    return () => clearInterval(timer);
  }, []);
  return (
    <Text color={theme.primary}>
      {FRAMES[frame]} {label ? <Text color={theme.muted}>{label}</Text> : null}
    </Text>
  );
}

export interface MenuItem {
  key: string;
  label: string;
  hint?: string;
}

/** Vertical selectable list driven by arrow keys / j / k. */
export function Menu({
  items,
  onSelect,
  isActive = true,
}: {
  items: MenuItem[];
  onSelect: (key: string) => void;
  isActive?: boolean;
}): React.JSX.Element {
  const [index, setIndex] = useState(0);

  useInput(
    (input, key) => {
      if (key.upArrow || input === "k") setIndex((i) => (i - 1 + items.length) % items.length);
      else if (key.downArrow || input === "j") setIndex((i) => (i + 1) % items.length);
      else if (key.return) {
        const item = items[index];
        if (item) onSelect(item.key);
      }
    },
    { isActive },
  );

  return (
    <Box flexDirection="column">
      {items.map((item, i) => {
        const selected = i === index;
        return (
          <Box key={item.key}>
            <Text color={selected ? theme.primary : theme.text} bold={selected}>
              {selected ? "❯ " : "  "}
              {item.label}
            </Text>
            {item.hint ? <Text color={theme.muted}>  {item.hint}</Text> : null}
          </Box>
        );
      })}
    </Box>
  );
}

/**
 * Single-line text input. Ink ships no input widget, and a hand-rolled one
 * keeps the dependency surface small.
 */
export function TextInput({
  value,
  onChange,
  onSubmit,
  placeholder,
  isActive = true,
}: {
  value: string;
  onChange: (next: string) => void;
  onSubmit: () => void;
  placeholder?: string;
  isActive?: boolean;
}): React.JSX.Element {
  useInput(
    (input, key) => {
      if (key.return) {
        onSubmit();
        return;
      }
      if (key.backspace || key.delete) {
        onChange(value.slice(0, -1));
        return;
      }
      // Ignore control chords so Ctrl+C still reaches the app handler.
      if (key.ctrl || key.meta || key.escape || key.tab) return;
      if (input) onChange(value + input);
    },
    { isActive },
  );

  return (
    <Box>
      <Text color={theme.primary}>❯ </Text>
      {value ? <Text>{value}</Text> : <Text color={theme.muted}>{placeholder ?? ""}</Text>}
      <Text color={theme.primary}>▏</Text>
    </Box>
  );
}

export function ErrorBox({ message }: { message: string }): React.JSX.Element {
  return (
    <Box marginTop={1}>
      <Text color={theme.danger}>✗ {message}</Text>
    </Box>
  );
}
