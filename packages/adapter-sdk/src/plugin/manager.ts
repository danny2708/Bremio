import type { AgentAdapter } from "../adapter";
import type {
  AgentRegistry,
  PluginDescriptor,
  PluginRegistration,
  PluginState,
} from "./types";

function cloneManifest(
  m: PluginDescriptor["manifest"],
): PluginDescriptor["manifest"] {
  return { ...m, supportedRoles: [...m.supportedRoles], configurationSchema: { ...m.configurationSchema } };
}

export class PluginManager {
  private readonly plugins = new Map<string, PluginRegistration>();

  register(descriptor: PluginDescriptor): this {
    if (this.plugins.has(descriptor.manifest.id)) {
      throw new Error(`Plugin already registered: ${descriptor.manifest.id}`);
    }
    this.plugins.set(descriptor.manifest.id, {
      descriptor: {
        manifest: cloneManifest(descriptor.manifest),
        hooks: descriptor.hooks,
      },
      state: "registered",
    });
    return this;
  }

  async activate(id: string): Promise<void> {
    const entry = this.plugins.get(id);
    if (!entry) throw new Error(`Plugin not registered: ${id}`);
    if (entry.state === "active") return;
    if (entry.state !== "registered" && entry.state !== "inactive" && entry.state !== "error") {
      throw new Error(
        `Cannot activate plugin ${id} from state "${entry.state}"`,
      );
    }

    entry.state = "activating";
    try {
      if (entry.descriptor.hooks?.onActivate) {
        await entry.descriptor.hooks.onActivate();
      }
      const adapter = entry.descriptor.manifest.adapterFactory();
      entry.adapter = adapter;
      entry.state = "active";
      entry.error = undefined;
    } catch (err) {
      entry.state = "error";
      const msg = err instanceof Error ? err.message : String(err);
      entry.error = msg;
      if (entry.descriptor.hooks?.onError) {
        await entry.descriptor.hooks.onError(err instanceof Error ? err : new Error(msg));
      }
      throw err;
    }
  }

  async activateAll(): Promise<void> {
    const errors: Array<{ id: string; error: Error }> = [];
    for (const id of this.plugins.keys()) {
      try {
        await this.activate(id);
      } catch (err) {
        errors.push({ id, error: err instanceof Error ? err : new Error(String(err)) });
      }
    }
    if (errors.length > 0) {
      const messages = errors.map((e) => `${e.id}: ${e.error.message}`).join("; ");
      throw new AggregateError(errors.map((e) => e.error), `Failed to activate plugins: ${messages}`);
    }
  }

  async deactivate(id: string): Promise<void> {
    const entry = this.plugins.get(id);
    if (!entry) throw new Error(`Plugin not registered: ${id}`);
    if (entry.state === "inactive") return;
    if (entry.state !== "active" && entry.state !== "error") {
      throw new Error(
        `Cannot deactivate plugin ${id} from state "${entry.state}"`,
      );
    }

    entry.state = "deactivating";
    try {
      entry.adapter = undefined;
      if (entry.descriptor.hooks?.onDeactivate) {
        await entry.descriptor.hooks.onDeactivate();
      }
      entry.state = "inactive";
      entry.error = undefined;
    } catch (err) {
      entry.state = "error";
      const msg = err instanceof Error ? err.message : String(err);
      entry.error = msg;
      if (entry.descriptor.hooks?.onError) {
        await entry.descriptor.hooks.onError(err instanceof Error ? err : new Error(msg));
      }
      throw err;
    }
  }

  async deactivateAll(): Promise<void> {
    const errors: Array<{ id: string; error: Error }> = [];
    for (const id of this.plugins.keys()) {
      try {
        await this.deactivate(id);
      } catch (err) {
        errors.push({ id, error: err instanceof Error ? err : new Error(String(err)) });
      }
    }
    if (errors.length > 0) {
      const messages = errors.map((e) => `${e.id}: ${e.error.message}`).join("; ");
      throw new AggregateError(errors.map((e) => e.error), `Failed to deactivate plugins: ${messages}`);
    }
  }

  getAdapter(id: string): AgentAdapter | undefined {
    const entry = this.plugins.get(id);
    return entry?.state === "active" ? entry.adapter : undefined;
  }

  getRegistry(): AgentRegistry {
    const registry: AgentRegistry = new Map();
    for (const [id, entry] of this.plugins) {
      if (entry.state === "active" && entry.adapter) {
        registry.set(id, entry.adapter);
      }
    }
    return registry;
  }

  list(): PluginRegistration[] {
    return [...this.plugins.values()].map((e) => ({
      descriptor: {
        manifest: cloneManifest(e.descriptor.manifest),
        hooks: e.descriptor.hooks,
      },
      state: e.state,
      error: e.error,
      adapter: e.adapter,
    }));
  }

  getState(id: string): PluginState | undefined {
    return this.plugins.get(id)?.state;
  }
}
