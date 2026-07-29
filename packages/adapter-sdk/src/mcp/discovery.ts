import type {
  Tool,
  ServerCapabilities,
  Resource,
  Prompt,
} from "@modelcontextprotocol/sdk/types";
import type {
  McpServerManifest,
} from "./manifest";
import type {
  McpClientHandle,
  McpServerDiscovery,
} from "./types";
import {
  connectClient,
} from "./transport";

export type { McpClientHandle, McpServerDiscovery };

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
