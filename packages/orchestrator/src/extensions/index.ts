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
  bremioMcpManifest,
  defaultBremioServerLaunch,
  type BremioServerLaunch,
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

export {
  PLAYBOOK_DIR,
  DEFAULT_PLAYBOOK_TOKEN_BUDGET,
  loadPlaybooks,
  formatPlaybooks,
  selectPlaybooks,
  type Playbook,
  type PlaybookSelection,
} from "./playbooks";

export {
  trustStorePath,
  configDigest,
  assertTrustedConfig,
  trustConfig,
  UntrustedConfigError,
} from "./trust";
