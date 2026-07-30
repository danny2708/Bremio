import { describe, expect, it } from "vitest";
import { gitActionClasses, isAutopilotDenied, type GitOperation } from "./git-actions";
import { evaluate } from "./policy";

const ALL_OPERATIONS: GitOperation[] = [
  "status",
  "diff",
  "log",
  "list-branches",
  "stage",
  "commit",
  "create-branch",
  "switch-branch",
  "fetch",
  "pull",
  "push",
  "force-push",
  "rewrite-history",
  "open-pull-request",
];

describe("git operations map to action classes (docs/15 §2.4.1)", () => {
  it("classifies every operation", () => {
    for (const op of ALL_OPERATIONS) {
      expect(gitActionClasses(op).length).toBeGreaterThan(0);
    }
  });

  it("refuses an operation it does not know rather than guessing a class", () => {
    expect(() => gitActionClasses("rm -rf" as GitOperation)).toThrow(/unknown git operation/);
  });

  it.each(["status", "diff", "log", "list-branches"] as GitOperation[])(
    "treats %s as an ordinary read",
    (op) => {
      expect(gitActionClasses(op)).toEqual(["read"]);
    },
  );

  it.each(["stage", "commit", "create-branch", "switch-branch"] as GitOperation[])(
    "treats %s as a write, so plan mode forbids it",
    (op) => {
      expect(gitActionClasses(op)).toContain("write");
      // The consequence worth pinning: an agent that commits in plan mode has
      // escaped plan mode, even though the edits were already on disk.
      for (const cls of gitActionClasses(op)) {
        expect(evaluate("plan", cls).allowed).toBe(false);
      }
    },
  );

  it("treats a pull as network AND write, since it can move the working tree", () => {
    // A caller that checked only `network` would let a pull fast-forward the
    // user's tree in plan mode.
    expect(gitActionClasses("pull")).toContain("network");
    expect(gitActionClasses("pull")).toContain("write");
  });

  it("treats push and opening a PR as network", () => {
    expect(gitActionClasses("push")).toContain("network");
    expect(gitActionClasses("open-pull-request")).toContain("network");
  });
});

describe("destructive git is denied under autopilot with no override", () => {
  it.each(["force-push", "rewrite-history"] as GitOperation[])(
    "classifies %s as git-destructive",
    (op) => {
      expect(gitActionClasses(op)).toContain("git-destructive");
      expect(isAutopilotDenied(op)).toBe(true);
    },
  );

  it.each(["force-push", "rewrite-history"] as GitOperation[])(
    "%s is refused by the policy matrix in every control mode",
    (op) => {
      // Autopilot denies it per §2.5, plan and approve deny it as any other
      // destructive class. There is no mode in which it is simply allowed.
      for (const cls of gitActionClasses(op)) {
        if (cls !== "git-destructive") continue;
        expect(evaluate("autopilot", cls).allowed).toBe(false);
        expect(evaluate("plan", cls).allowed).toBe(false);
      }
    },
  );

  it("does not mark an ordinary push as autopilot-denied", () => {
    // The failure this guards: treating force-push and push as the same
    // operation, in either direction. Downgrading a force-push to a push
    // silently substitutes a different operation; promoting a push to
    // git-destructive would block normal work.
    expect(isAutopilotDenied("push")).toBe(false);
    expect(evaluate("autopilot", "network").allowed).toBe(true);
  });

  it.each(ALL_OPERATIONS.filter((op) => op !== "force-push" && op !== "rewrite-history"))(
    "does not classify %s as destructive",
    (op) => {
      expect(isAutopilotDenied(op)).toBe(false);
    },
  );
});
