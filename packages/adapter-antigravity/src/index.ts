// @bremio/adapter-antigravity — AgentAdapter over the authenticated `agy` CLI.
export {
  AntigravityAdapter,
  buildAgyInvocation,
  type AntigravityAdapterOptions,
  type AgyInvocation,
} from "./antigravity-adapter";

export {
  resolveAgyBinary,
  agyLooksSignedIn,
  agyStateFile,
  formatPrintTimeout,
} from "./agy-cli";
