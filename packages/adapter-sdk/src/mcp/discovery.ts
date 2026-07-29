import {
  Client,
} from "@modelcontextprotocol/sdk/client";
import {
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio";
import {
  SSEClientTransport,
} from "@modelcontextprotocol/sdk/client/sse";
import {
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/sdk/client/streamableHttp";
import type {
  Tool,
  ServerCapabilities,
  Resource,
  Prompt,
} from "@modelcontextprotocol/sdk/types";
import type {
  McpServerManifest,
  McpTransportConfig,
} from "./manifest";

export interface McpServerDiscovery {
  manifest: McpServerManifest;
  serverName: string;
  serverVersion: string;
  capabilities: ServerCapabilities;
  tools: Tool[];
  resources: Resource[];
  prompts: Prompt[];
}

export interface McpClientHandle {
  getServerCapabilities(): ServerCapabilities | undefined;
  getServerVersion(): { name: string; version: string } | undefined;
  listTools(): Promise<{ tools: Tool[] }>;
  listResources(): Promise<{ resources: Resource[] }>;
  listPrompts(): Promise<{ prompts: Prompt[] }>;
  close(): Promise<void>;
}

function createTransport(config: McpTransportConfig): unknown {
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

async function connectClient(
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

export type ConnectClientFn = (
  manifest: McpServerManifest,
) => Promise<McpClientHandle>;

export class McpDiscovery {
  constructor(
    private readonly connectClientFn: ConnectClientFn = connectClient,
  ) {}

  async discover(
    manifests: McpServerManifest[],
  ): Promise<McpServerDiscovery[]> {
    const results: McpServerDiscovery[] = [];

    for (const manifest of manifests) {
      const discovery = await this.discoverServer(manifest);
      if (discovery) results.push(discovery);
    }

    return results;
  }

  private async discoverServer(
    manifest: McpServerManifest,
  ): Promise<McpServerDiscovery | null> {
    let client: McpClientHandle | null = null;
    try {
      client = await this.connectClientFn(manifest);

      const capabilities = client.getServerCapabilities() ?? {};
      const serverVersion = client.getServerVersion();
      const serverName = serverVersion?.name ?? manifest.name;
      const serverVersionStr = serverVersion?.version ?? "0.0.0";

      const [toolsResult, resourcesResult, promptsResult] =
        await Promise.all([
          capabilities.tools
            ? client.listTools().catch(() => ({ tools: [] as Tool[] }))
            : Promise.resolve({ tools: [] as Tool[] }),
          capabilities.resources
            ? client
                .listResources()
                .catch(() => ({ resources: [] as Resource[] }))
            : Promise.resolve({ resources: [] as Resource[] }),
          capabilities.prompts
            ? client
                .listPrompts()
                .catch(() => ({ prompts: [] as Prompt[] }))
            : Promise.resolve({ prompts: [] as Prompt[] }),
        ]);

      return {
        manifest,
        serverName,
        serverVersion: serverVersionStr,
        capabilities,
        tools: toolsResult.tools,
        resources: resourcesResult.resources,
        prompts: promptsResult.prompts,
      };
    } catch {
      return null;
    } finally {
      if (client) {
        await client.close().catch(() => {});
      }
    }
  }
}
