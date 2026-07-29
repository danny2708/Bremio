// The `.js` suffixes are required, not stylistic: the SDK's exports map points
// at real ESM files, so esbuild cannot resolve the extensionless form and
// `pnpm build` fails on it. `tsc` accepts it either way, which is why
// typecheck-only verification missed this.
import {
  Client,
} from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  SSEClientTransport,
} from "@modelcontextprotocol/sdk/client/sse.js";
import {
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  McpServerManifest,
  McpTransportConfig,
} from "./manifest";
import type {
  McpClientHandle,
} from "./types";

export function createTransport(config: McpTransportConfig): unknown {
  switch (config.type) {
    case "stdio":
      return new StdioClientTransport({
        command: config.command,
        args: [...config.args],
        ...(config.env ? { env: config.env } : {}),
        ...(config.cwd ? { cwd: config.cwd } : {}),
      });
    case "sse":
      return new SSEClientTransport(new URL(config.url));
    case "streamable-http":
      return new StreamableHTTPClientTransport(new URL(config.url));
  }
}

export async function connectClient(
  manifest: McpServerManifest,
): Promise<McpClientHandle> {
  const client = new Client({ name: "bremio", version: "1.0.0" });
  const transport = createTransport(manifest.transport);
  try {
    await client.connect(transport as never);
  } catch {
    await client.close().catch(() => {});
    throw new Error(
      `failed to connect to MCP server "${manifest.id}": transport connection refused`,
    );
  }
  return client as unknown as McpClientHandle;
}
