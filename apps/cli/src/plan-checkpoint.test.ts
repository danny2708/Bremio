import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Plan } from "@bremio/protocol";
import { answerDaemonCheckpoint, NON_INTERACTIVE_REASON, promptPlanDecision, type PlanPromptIo } from "./plan-checkpoint";

const PLAN: Plan = {
  summary: "s",
  leadAgentId: "claude",
  tasks: [{
    id: "T1", title: "do it", kind: "implementation", risk: "low", requiredCapabilities: [],
    preferredAgents: [], dependencies: [], expectedArtifacts: [], acceptanceCriteria: ["works"],
  }],
};

function io(answers: Array<string | ((question: string) => Promise<string>)>, interactive = true): PlanPromptIo & { printed: string[] } {
  const printed: string[] = [];
  return {
    interactive,
    printed,
    print: (line) => printed.push(line),
    async ask(question) {
      const next = answers.shift();
      if (next === undefined) throw new Error(`unexpected question: ${question}`);
      return typeof next === "string" ? next : next(question);
    },
  };
}

describe("P2-T2 CLI plan checkpoint", () => {
  it("fails closed without a terminal, and never asks", async () => {
    const decision = await promptPlanDecision(PLAN, io([], false));
    expect(decision).toEqual({ decision: "reject", reason: NON_INTERACTIVE_REASON, decidedBy: "cli" });
  });

  it("shows the plan and re-asks until it gets a known answer", async () => {
    const terminal = io(["maybe", "a"]);
    expect(await promptPlanDecision(PLAN, terminal)).toEqual({ decision: "approve", decidedBy: "cli" });
    expect(terminal.printed.join("\n")).toMatch(/T1 \[implementation\/low\] do it/);
  });

  it("edit hands back whatever the user saved", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "bremio-ckpt-cli-"));
    let editedFile = "";
    const terminal = {
      ...io(["e", async () => {
        const dir = (await fs.readdir(tmp))[0]!;
        editedFile = path.join(tmp, dir, "plan.json");
        const plan = JSON.parse(await fs.readFile(editedFile, "utf8")) as Plan;
        plan.tasks[0]!.title = "do it better";
        await fs.writeFile(editedFile, JSON.stringify(plan));
        return "";
      }]),
      editDir: tmp,
    };
    const decision = await promptPlanDecision(PLAN, terminal);
    expect(decision.decision).toBe("edit");
    expect((decision as { plan: Plan }).plan.tasks[0]?.title).toBe("do it better");
    // the scratch copy is removed
    await expect(fs.stat(editedFile)).rejects.toThrow();
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("answers a daemon checkpoint through the approval routes", async () => {
    const posts: Array<{ route: string; body: unknown }> = [];
    const client = { post: async (route: string, body?: unknown) => { posts.push({ route, body }); return {} as never; } };
    const event = { kind: "plan-checkpoint", data: { requestId: "apr-1", plan: PLAN } };
    expect(await answerDaemonCheckpoint(client, event, io([], false))).toBe(true);
    expect(posts[0]).toEqual({
      route: "/approval/requests/apr-1/decide",
      body: { decision: "rejected", decidedBy: "cli", reason: NON_INTERACTIVE_REASON },
    });
    // the follow-up "decision" event carries no plan and is ignored
    expect(await answerDaemonCheckpoint(client, { kind: "plan-checkpoint", data: { requestId: "apr-1" } }, io([]))).toBe(false);
  });
});
