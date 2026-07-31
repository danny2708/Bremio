import { describe, expect, it } from "vitest";
import { assemblePlanChecklist, panelHtml } from "./webview";

/** The `plan` event the daemon emits from `runBremio`'s `onPlan` hook. */
function planEvent(
  tasks: Array<{ id: string; title: string; dependencies?: string[] }>,
  assign: Record<string, string> = {},
  summary = "do the thing",
) {
  return { kind: "plan", data: { plan: { summary, tasks }, assign } };
}

describe("assemblePlanChecklist (S10-T3)", () => {
  it("lists every planned task, including ones that have not started", () => {
    // The reason this exists rather than reusing `assembleTaskLanes`: lanes are
    // built from events, so a task the scheduler has not reached yet does not
    // appear at all — and "two still to do" is most of what a checklist is for.
    const result = assemblePlanChecklist([
      planEvent([
        { id: "TASK-001", title: "write the parser" },
        { id: "TASK-002", title: "write the tests" },
        { id: "TASK-003", title: "wire it up", dependencies: ["TASK-001"] },
      ]),
      { kind: "task-start", taskId: "TASK-001", message: "write the parser" },
    ]);

    expect(result.tasks.map((t) => t.id)).toEqual(["TASK-001", "TASK-002", "TASK-003"]);
    expect(result.tasks.map((t) => t.status)).toEqual(["running", "pending", "pending"]);
    expect(result.summary).toBe("do the thing");
  });

  it("tracks each task through start and completion", () => {
    const result = assemblePlanChecklist([
      planEvent([
        { id: "TASK-001", title: "a" },
        { id: "TASK-002", title: "b" },
        { id: "TASK-003", title: "c" },
      ]),
      { kind: "task-start", taskId: "TASK-001" },
      { kind: "task-complete", taskId: "TASK-001", message: "completed" },
      { kind: "task-start", taskId: "TASK-002" },
      { kind: "task-complete", taskId: "TASK-002", message: "failed" },
      { kind: "task-start", taskId: "TASK-003" },
    ]);

    expect(result.tasks.map((t) => t.status)).toEqual(["completed", "failed", "running"]);
  });

  it("records which agent each task was assigned to", () => {
    const result = assemblePlanChecklist([
      planEvent(
        [{ id: "TASK-001", title: "a" }, { id: "TASK-002", title: "b" }],
        { "TASK-001": "codex", "TASK-002": "antigravity" },
      ),
    ]);

    expect(result.tasks.map((t) => t.agentId)).toEqual(["codex", "antigravity"]);
  });

  it("keeps the dependencies that explain why something is waiting", () => {
    const result = assemblePlanChecklist([
      planEvent([
        { id: "TASK-001", title: "a" },
        { id: "TASK-002", title: "b", dependencies: ["TASK-001"] },
      ]),
    ]);

    expect(result.tasks[1]!.dependsOn).toEqual(["TASK-001"]);
  });

  it("shows work that happened even when the plan never mentioned it", () => {
    // Dropping it would hide work from the user, which is worse than a
    // checklist that is longer than the plan.
    const result = assemblePlanChecklist([
      planEvent([{ id: "TASK-001", title: "a" }]),
      { kind: "task-start", taskId: "TASK-099", message: "something unplanned", agentId: "codex" },
      { kind: "task-complete", taskId: "TASK-099", message: "completed" },
    ]);

    expect(result.tasks.map((t) => t.id)).toEqual(["TASK-001", "TASK-099"]);
    expect(result.tasks[1]).toMatchObject({ status: "completed", agentId: "codex" });
  });

  it("returns nothing to render for a Solo turn with no plan", () => {
    const result = assemblePlanChecklist([
      { kind: "status", message: "claude started" },
      { kind: "task-event", message: "editing a file" },
    ]);

    expect(result.tasks).toEqual([]);
    expect(result.summary).toBeUndefined();
  });

  it("replays a finished turn to the same checklist it showed live", () => {
    // Pure and event-sourced: the transcript and the live view read the same
    // events through the same rule, so history cannot drift from what was seen.
    const events = [
      planEvent([{ id: "TASK-001", title: "a" }, { id: "TASK-002", title: "b" }]),
      { kind: "task-start", taskId: "TASK-001" },
      { kind: "task-complete", taskId: "TASK-001", message: "completed" },
    ];
    expect(assemblePlanChecklist(events)).toEqual(assemblePlanChecklist([...events]));
  });
});

describe("the plan checklist reports rather than offers", () => {
  const html = panelHtml("nonce", "vscode-resource:", "icon.png");
  const script = html.split('<script nonce="nonce">')[1]!.split("</script>")[0]!;

  function loadPanel(): { renderPlanChecklist: (p: unknown) => string } {
    const stub: unknown = new Proxy(function () {}, {
      get: (_t, prop) => (prop === Symbol.toPrimitive ? () => "" : stub),
      set: () => true,
      apply: () => stub,
      construct: () => stub as object,
    });
    const run = new Function(
      "document", "window", "acquireVsCodeApi", "console",
      `${script}\nreturn { renderPlanChecklist };`,
    ) as (...a: unknown[]) => { renderPlanChecklist: (p: unknown) => string };
    return run(stub, stub, () => stub, console);
  }

  const panel = loadPanel();

  it("renders a progress count and every task", () => {
    const out = panel.renderPlanChecklist({
      summary: "ship it",
      tasks: [
        { id: "T1", title: "one", status: "completed", dependsOn: [], agentId: "codex" },
        { id: "T2", title: "two", status: "running", dependsOn: [] },
        { id: "T3", title: "three", status: "pending", dependsOn: ["T2"] },
      ],
    });

    expect(out).toContain("Plan · 1/3 done");
    expect(out).toContain("one");
    expect(out).toContain("three");
    expect(out).toContain("codex");
    expect(out).toContain("after T2");
  });

  it("offers no control the user could mistake for editing the agent's plan", () => {
    // These are the agent's items. A checkbox would claim the user can change
    // what the agent is doing, and they cannot.
    const out = panel.renderPlanChecklist({
      tasks: [{ id: "T1", title: "one", status: "pending", dependsOn: [] }],
    });

    expect(out).not.toContain("<input");
    expect(out).not.toContain("<button");
    expect(out).not.toContain("data-");
  });

  it("renders nothing when there is no plan", () => {
    expect(panel.renderPlanChecklist(undefined)).toBe("");
    expect(panel.renderPlanChecklist({ tasks: [] })).toBe("");
  });
});
