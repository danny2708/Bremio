import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@bremio/protocol": path.resolve(__dirname, "packages/protocol/src/index.ts"),
      "@bremio/adapter-sdk": path.resolve(__dirname, "packages/adapter-sdk/src/index.ts"),
      "@bremio/workspace": path.resolve(__dirname, "packages/workspace/src/index.ts"),
      "@bremio/quota": path.resolve(__dirname, "packages/quota/src/index.ts"),
      "@bremio/event-view": path.resolve(__dirname, "packages/event-view/src/index.ts"),
      "@bremio/harness": path.resolve(__dirname, "packages/harness/src/index.ts"),
      "@bremio/adapter-claude": path.resolve(__dirname, "packages/adapter-claude/src/index.ts"),
      "@bremio/adapter-codex": path.resolve(__dirname, "packages/adapter-codex/src/index.ts"),
      "@bremio/adapter-opencode": path.resolve(__dirname, "packages/adapter-opencode/src/index.ts"),
      "@bremio/adapter-antigravity": path.resolve(__dirname, "packages/adapter-antigravity/src/index.ts"),
      "@bremio/adapter-local": path.resolve(__dirname, "packages/adapter-local/src/index.ts"),
      "@bremio/daemon-client": path.resolve(__dirname, "packages/daemon-client/src/index.ts"),
      "@bremio/memory": path.resolve(__dirname, "packages/memory/src/index.ts"),
    },
  },
  test: {
    include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts"],
    environment: "node",
    fileParallelism: false,
  },
});
