import { promises as fs } from "node:fs";
import path from "node:path";
import { type MemoryScope, type MemoryEntry, resolveStorageDir } from "./types";
import type { MemoryQuery, MemoryStore } from "./store";

export class FsMemoryStore implements MemoryStore {
  private readonly rootDir: string;

  constructor(rootDir: string) {
    if (!rootDir) throw new Error("FsMemoryStore requires a root directory");
    this.rootDir = path.resolve(rootDir);
  }

  /**
   * Turn an entry id into a path inside the store, or refuse.
   *
   * The id reaches here from a `MemoryEntry`, and the proposal lifecycle exists
   * specifically so an *agent* can suggest entries — so the id is untrusted
   * input. `path.join(root, dir, `${id}.json`)` happily walks out of the store
   * on an id like `../../../../.bashrc`, which turns `store()` into an
   * arbitrary-file-write. `outside-workspace` is denied even under autopilot
   * (docs/15 §2.5); the storage layer should not be the way around that.
   */
  private resolvePath(scope: MemoryScope, id: string): string {
    const storageDir = resolveStorageDir(scope);
    const base = path.resolve(this.rootDir, storageDir);
    const resolved = path.resolve(base, `${id}.json`);
    const relative = path.relative(base, resolved);
    if (
      relative === "" ||
      relative.startsWith("..") ||
      path.isAbsolute(relative) ||
      path.dirname(relative) !== "."
    ) {
      throw new Error(
        `memory entry id "${id}" would write outside the ${scope} memory directory`,
      );
    }
    return resolved;
  }

  private async ensureDir(filePath: string): Promise<void> {
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
  }

  async store(entry: MemoryEntry): Promise<void> {
    if (entry.scope === "session") {
      throw new Error("FsMemoryStore cannot persist session-scoped memory");
    }
    const filePath = this.resolvePath(entry.scope, entry.id);
    await this.ensureDir(filePath);
    await fs.writeFile(filePath, JSON.stringify(entry, null, 2), "utf-8");
  }

  async get(id: string): Promise<MemoryEntry | undefined> {
    for (const scope of ["project", "user"] as MemoryScope[]) {
      const filePath = this.resolvePath(scope, id);
      try {
        const raw = await fs.readFile(filePath, "utf-8");
        return JSON.parse(raw) as MemoryEntry;
      } catch {
        continue;
      }
    }
    return undefined;
  }

  async query(filter: MemoryQuery): Promise<MemoryEntry[]> {
    const scopes = filter.scopes ?? (["project", "user"] as MemoryScope[]);
    const results: MemoryEntry[] = [];

    for (const scope of scopes) {
      const dir = path.join(this.rootDir, resolveStorageDir(scope));
      let files: string[];
      try {
        files = await fs.readdir(dir);
      } catch {
        continue;
      }
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        try {
          const raw = await fs.readFile(path.join(dir, file), "utf-8");
          const entry = JSON.parse(raw) as MemoryEntry;
          if (filter.tags && filter.tags.length > 0 && !filter.tags.some((t) => entry.tags.includes(t))) continue;
          if (filter.sourceKinds && filter.sourceKinds.length > 0 && !filter.sourceKinds.includes(entry.source.kind)) continue;
          if (filter.ids && filter.ids.length > 0 && !filter.ids.includes(entry.id)) continue;
          results.push(entry);
        } catch {
          continue;
        }
      }
    }

    if (filter.limit !== undefined && filter.limit >= 0) {
      return results.slice(0, filter.limit);
    }
    return results;
  }

  async delete(id: string): Promise<boolean> {
    for (const scope of ["project", "user"] as MemoryScope[]) {
      const filePath = this.resolvePath(scope, id);
      try {
        await fs.unlink(filePath);
        return true;
      } catch {
        continue;
      }
    }
    return false;
  }

  async list(scope: MemoryScope): Promise<MemoryEntry[]> {
    return this.query({ scopes: [scope] });
  }
}
