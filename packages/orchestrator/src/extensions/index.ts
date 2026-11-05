export {
  extendAdapter,
  extendRegistry,
  type RunExtensions,
} from "./extend-adapter";

export {
  MCP_MANIFEST_FILE,
  parseMcpManifests,
  loadMcpManifests,
  selectMcpServers,
  mcpPolicyGate,
  assertMcpRequestUsable,
} from "./mcp-config";

export {
  prepareRunExtensions,
  type RunExtensionInput,
  type PreparedRunExtensions,
} from "./prepare";

export {
  HOOKS_FILE,
  parseHookDefinitions,
  commandHookHandler,
  loadHookManager,
  evaluateRepositoryHook,
  describeHookVeto,
  type HookDefinition,
} from "./hooks-config";
