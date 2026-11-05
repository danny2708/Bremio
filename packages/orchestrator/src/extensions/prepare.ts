import type { ControlMode } from "@bremio/policy";
import type { AgentRegistry } from "../registry";
import { extendRegistry } from "./extend-adapter";
import { assertMcpRequestUsable, loadMcpManifests, selectMcpServers } from "./mcp-config";
import { loadHookManager } from "./hooks-config";
import { selectPlaybooks } from "./playbooks";

export interface RunExtensionInput {
  repoPath: string;
  /** Defaults to `autopilot`, the orchestrator's own default. */
  controlMode?: ControlMode;
  /** MCP server ids the run opted into (P3-T1). */
  mcpServers?: string[];
  /** Playbook names from `.bremio/skills/` to inject (P3-T3). */
  skills?: string[];
  /** Token budget for the injected playbooks. */
  playbookTokenBudget?: number;
}

export interface PreparedRunExtensions {
  registry: AgentRegistry;
  /**
   * Set when the run asked for something it cannot have (unknown server,
   * policy forbids MCP). The caller raises it through its normal failure path
   * so the run ends `failed` with this reason rather than starting without
   * what the user asked for.
   */
  error?: Error;
}

/**
 * Wrap a run's registry with docs/17 P3 extensions. Every run gets the MCP
 * policy gate for its control mode, even without opted-in servers, so a
 * provider's own MCP calls are governed by the run's mode too.
 */
export async function prepareRunExtensions(
  input: RunExtensionInput,
  registry: AgentRegistry,
): Promise<PreparedRunExtensions> {
  const controlMode = input.controlMode ?? "autopilot";
  try {
    const servers = input.mcpServers?.length
      ? selectMcpServers(await loadMcpManifests(input.repoPath), input.mcpServers)
      : [];
    assertMcpRequestUsable(controlMode, servers);
    // An unreadable hooks file fails the run (below): the user configured a
    // guard, and running without it would be the silent skip P3 forbids.
    const hooks = await loadHookManager(input.repoPath);
    const playbooks = await selectPlaybooks(input.repoPath, input.skills, input.playbookTokenBudget);
    return {
      registry: extendRegistry(registry, {
        controlMode,
        mcpServers: servers,
        repoPath: input.repoPath,
        ...(hooks ? { hooks } : {}),
        ...(playbooks.playbooks.length > 0 ? { playbooks } : {}),
      }),
    };
  } catch (err) {
    // The gate still applies: a failed preparation must not leave a registry
    // that allows MCP calls the run's mode forbids.
    return {
      registry: extendRegistry(registry, { controlMode }),
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }
}
