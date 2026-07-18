/**
 * Bremio TUI theme. The brand red is the primary accent; everything else is a
 * neutral or a status colour so the red stays meaningful rather than decorative.
 */
export const theme = {
  /** Brand red — headings, selection, focus. */
  primary: "#d43002",
  /** Softer red for secondary brand marks. */
  primaryDim: "#8f2202",
  text: "white",
  muted: "gray",
  success: "green",
  warning: "yellow",
  danger: "red",
  info: "cyan",
} as const;

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
