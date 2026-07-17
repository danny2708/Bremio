import type { AgentAdapter } from "@bremio/adapter-sdk";

export type AgentRegistry = Map<string, AgentAdapter>;

/** Build an id → adapter registry. Later adapters win on id collision. */
export function createRegistry(adapters: AgentAdapter[]): AgentRegistry {
  const registry: AgentRegistry = new Map();
  for (const adapter of adapters) registry.set(adapter.id, adapter);
  return registry;
}
