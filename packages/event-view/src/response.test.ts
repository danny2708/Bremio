import { describe, expect, it } from "vitest";
import { extractResponse } from "./index";

describe("extractResponse", () => {
  it("joins streamed message fragments into the answer", () => {
    // How Antigravity and Claude actually arrive: one event per line.
    expect(
      extractResponse([
        { type: "started" },
        { type: "message", role: "assistant", text: "### Findings" },
        { type: "tool_use", name: "shell" },
        { type: "message", role: "assistant", text: "The project is well documented." },
      ]),
    ).toBe("### Findings\nThe project is well documented.");
  });

  it("prefers the provider's own final text when it is not truncated", () => {
    expect(
      extractResponse([
        { type: "message", role: "assistant", text: "partial" },
        { type: "completed", outcome: { finalText: "the complete considered answer" } },
      ]),
    ).toBe("the complete considered answer");
  });

  it("keeps the streamed text when the reported final text is shorter", () => {
    // A provider that streams in full but reports a clipped summary must not
    // cost the user the part it clipped.
    const streamed = "line one that is quite long indeed";
    expect(
      extractResponse([
        { type: "message", role: "assistant", text: streamed },
        { type: "completed", outcome: { finalText: "line one…" } },
      ]),
    ).toBe(streamed);
  });

  it("treats a message with no role as the assistant's, not as unattributed", () => {
    expect(extractResponse([{ type: "message", text: "answer" }])).toBe("answer");
  });

  it("ignores a message explicitly attributed to the user", () => {
    expect(
      extractResponse([
        { type: "message", role: "user", text: "my prompt" },
        { type: "message", role: "assistant", text: "my answer" },
      ]),
    ).toBe("my answer");
  });

  it("reads persisted events, which carry the type under `kind`", () => {
    // The daemon stores the event type in `kind`; the live stream uses `type`.
    // Reading only one of them is how the transcript came back empty.
    expect(extractResponse([{ kind: "message", text: "from storage" }])).toBe("from storage");
  });

  it("returns undefined when the agent never answered", () => {
    expect(extractResponse([{ type: "started" }, { type: "tool_use" }])).toBeUndefined();
  });
});
