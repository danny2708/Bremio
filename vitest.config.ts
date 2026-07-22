import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts"],
    environment: "node",
    // Several suites spawn real child processes and run git (adapter runs,
    // process-supervisor, worktrees, merge). Run in parallel across forked
    // workers on Windows they contend for OS handles and a worker can crash
    // (tinypool onUnexpectedExit), cascading unrelated files to red — the same
    // suite goes 351/351 one run and reports 9 "failures" the next. Files run
    // one at a time; tests within a file still run together, and the scheduler's
    // own concurrency is covered inside run.integration, so nothing is lost but
    // the flakiness. See docs/10 §5.
    fileParallelism: false,
  },
});
