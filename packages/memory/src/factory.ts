import type { MemoryScope } from "./types";
import { getScopeConfig } from "./types";
import { FsMemoryStore } from "./fs-store";
import { InMemoryStore } from "./store";
import type { MemoryStore } from "./store";

export interface CreateMemoryStoreOptions {
  projectDir?: string;
  userDir?: string;
}

export function createMemoryStore(
  scope: MemoryScope,
  options?: CreateMemoryStoreOptions,
): MemoryStore {
  const cfg = getScopeConfig(scope);
  if (cfg.persistence === "transient") {
    return new InMemoryStore();
  }
  if (scope === "project") {
    const dir = options?.projectDir;
    if (!dir) throw new Error("projectDir is required for project scope memory store");
    return new FsMemoryStore(dir);
  }
  if (scope === "user") {
    const dir = options?.userDir;
    if (!dir) throw new Error("userDir is required for user scope memory store");
    return new FsMemoryStore(dir);
  }
  throw new Error(`Unknown scope: ${scope}`);
}
