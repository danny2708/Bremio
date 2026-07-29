import type { AgentAdapter, AgentPluginManifest } from "../adapter";

export type PluginState =
  | "registered"
  | "activating"
  | "active"
  | "deactivating"
  | "inactive"
  | "error";

export interface PluginLifecycleHooks {
  onActivate?(): Promise<void>;
  onDeactivate?(): Promise<void>;
  onError?(error: Error): Promise<void>;
}

export interface PluginDescriptor {
  manifest: AgentPluginManifest;
  hooks?: PluginLifecycleHooks;
}

export interface PluginRegistration {
  descriptor: PluginDescriptor;
  state: PluginState;
  error?: string;
  adapter?: AgentAdapter;
}

export type AgentRegistry = Map<string, AgentAdapter>;
