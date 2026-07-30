import { promises as fs } from "node:fs";
import path from "node:path";
import { type MemoryScope, type MemoryEntry, resolveStorageDir } from "./types";
import type { MemoryQuery, MemoryStore } from "./store";

export class FsMemoryStore implements MemoryStore {
  private readonly rootDir: string;

  constructor(rootDir: string) {
    if (!rootDir) throw new Error("FsMemoryStore requires a root directory");
    this.rootDir = rootDir;
  }

  private resolvePath(scope: MemoryScope, id: string): string {
    const storageDir = resolveStorageDir(scope);
    return path.join(this.rootDir, storageDir, `${id}.json`);
  }

  private async ensureDir(filePath: string): Promise<void> {
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
  }

  async store(entry: MemoryEntry): Promise<void> {
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
