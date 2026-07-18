/**
 * Bremio TUI theme.
 *
 * Three separate layers of meaning, deliberately never mixed:
 *   blue        = Bremio itself — brand, navigation, selection, active state
 *   yellow      = lead role, actions, and things wanting attention
 *   agent colour = provider identity
 *
 * Yellow is reserved for small marks. Large yellow areas read as a warning
 * dashboard and would drown out real alerts.
 *
 * The background/surface/border tokens from the brand palette are deliberately
 * absent: a terminal owns its own background, so painting one here would fight
 * the user's colour scheme (and look broken on light themes). Those tokens
 * belong to the VS Code webview, which does own its surface.
 */
export const theme = {
  /** Brand blue — headings, selection, focus, active state. */
  primary: "#2563eb",
  primaryHover: "#3b82f6",
  primaryActive: "#1d4ed8",
  /** Softer brand blue for secondary marks. */
  primaryDim: "#172554",
  /** Accent yellow — lead badge, run action, attention. Never large areas. */
  accent: "#f4c542",
  accentHover: "#ffd75e",
  accentActive: "#d9a91e",
  text: "#f8fafc",
  textSecondary: "#b8c2d1",
  muted: "#7f8a9c",
  success: "green",
  warning: "#f4c542",
  danger: "red",
  info: "cyan",
} as const;

/**
 * Provider identity colours, desaturated so they never compete with the brand
 * blue. Keyed by Bremio adapter id — `antigravity` is the adapter; Gemini is
 * only the model behind it.
 */
export const AGENT_COLORS: Record<string, string> = {
  claude: "#c9864a",
  codex: "#34a77b",
  antigravity: "#7c83f6",
  opencode: "#a071d1",
  jan: "#32b8c6",
};

export function colorForAgent(agentId: string): string {
  return AGENT_COLORS[agentId] ?? theme.textSecondary;
}

export type StatusTone = "success" | "warning" | "danger" | "muted" | "info";

/** Map an adapter/task status word to a tone. */
export function toneForStatus(status: string): StatusTone {
  switch (status) {
    case "ok":
    case "completed":
    case "passed":
    case "healthy":
      return "success";
    case "degraded":
    case "limited":
    case "aging":
    case "cancelled":
    case "unverified":
      return "warning";
    case "unavailable":
    case "failed":
    case "exhausted":
    case "critical":
      return "danger";
    case "unknown":
    case "stale":
      return "muted";
    default:
      return "info";
  }
}

export function colorForTone(tone: StatusTone): string {
  switch (tone) {
    case "success":
      return theme.success;
    case "warning":
      return theme.warning;
    case "danger":
      return theme.danger;
    case "muted":
      return theme.muted;
    case "info":
      return theme.info;
  }
}

export function glyphForStatus(status: string): string {
  const tone = toneForStatus(status);
  if (tone === "success") return "✓";
  if (tone === "danger") return "✗";
  if (tone === "warning") return "▲";
  return "•";
}
