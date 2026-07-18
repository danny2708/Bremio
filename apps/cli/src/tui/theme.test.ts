import { describe, expect, it } from "vitest";
import {
  AGENT_COLORS,
  colorForAgent,
  colorForTone,
  glyphForStatus,
  theme,
  toneForStatus,
} from "./theme";

/** Colours the brand deliberately moved away from. */
const RETIRED_BRAND_COLOURS = ["#d43002", "#8f2202"];

describe("TUI palette", () => {
  it("uses Bremio blue as the primary accent", () => {
    expect(theme.primary).toBe("#2563eb");
    expect(theme.primaryActive).toBe("#1d4ed8");
  });

  it("reserves yellow for actions and attention", () => {
    expect(theme.accent).toBe("#f4c542");
    expect(theme.warning).toBe(theme.accent);
  });

  it("carries no trace of the retired coral brand", () => {
    const values = Object.values(theme).map((value) => String(value).toLowerCase());
    for (const retired of RETIRED_BRAND_COLOURS) {
      expect(values).not.toContain(retired);
    }
  });

  it("never paints the terminal background", () => {
    // The terminal owns its background. These are webview surface tokens, and
    // using one as a foreground here would be invisible on a dark theme and
    // would fight a light one.
    const surfaceTokens = ["#0b1220", "#111827", "#182235", "#263348"];
    const values = Object.values(theme).map((value) => String(value).toLowerCase());
    for (const surface of surfaceTokens) {
      expect(values).not.toContain(surface);
    }
  });

  it("keeps primaryMuted out of foreground use", () => {
    // #172554 is a near-black fill colour; as text on a dark terminal it would
    // be unreadable, so the wordmark fades through primaryActive instead.
    expect(theme.primaryDim).toBe("#172554");
    expect(theme.primary).not.toBe(theme.primaryDim);
  });
});

describe("agent identity", () => {
  it("gives every supported provider its own colour", () => {
    expect(colorForAgent("claude")).toBe("#c9864a");
    expect(colorForAgent("codex")).toBe("#34a77b");
    expect(colorForAgent("antigravity")).toBe("#7c83f6");
  });

  it("never reuses the brand blue for a provider", () => {
    // Provider colour is identity; blue means Bremio itself. Overlapping them
    // would make a selected agent indistinguishable from system state.
    for (const colour of Object.values(AGENT_COLORS)) {
      expect(colour).not.toBe(theme.primary);
    }
  });

  it("falls back to a neutral for an unknown provider", () => {
    expect(colorForAgent("something-else")).toBe(theme.textSecondary);
  });
});

describe("status tones", () => {
  it("maps success, warning and failure to their tones", () => {
    expect(toneForStatus("completed")).toBe("success");
    expect(toneForStatus("ok")).toBe("success");
    expect(toneForStatus("degraded")).toBe("warning");
    expect(toneForStatus("failed")).toBe("danger");
    expect(toneForStatus("unavailable")).toBe("danger");
  });

  it("treats unknown and stale as muted rather than as errors", () => {
    expect(toneForStatus("unknown")).toBe("muted");
    expect(toneForStatus("stale")).toBe("muted");
  });

  it("treats cancellation as a warning, not a failure", () => {
    // Cancelling is a decision the user made; it is not an error state.
    expect(toneForStatus("cancelled")).toBe("warning");
    expect(colorForTone(toneForStatus("cancelled"))).toBe(theme.accent);
  });

  it("uses red only for genuine failure", () => {
    expect(colorForTone("danger")).toBe(theme.danger);
    // Navigation and ordinary choices must never borrow the failure colour.
    expect(colorForTone("info")).not.toBe(theme.danger);
    expect(colorForTone("muted")).not.toBe(theme.danger);
    expect(colorForTone("success")).not.toBe(theme.danger);
  });

  it("gives each tone a distinct glyph so colour is not the only signal", () => {
    // Terminals with no colour, and colour-blind users, still need to tell
    // these apart.
    expect(glyphForStatus("completed")).toBe("✓");
    expect(glyphForStatus("failed")).toBe("✗");
    expect(glyphForStatus("degraded")).toBe("▲");
    expect(glyphForStatus("unknown")).toBe("•");
  });
});
