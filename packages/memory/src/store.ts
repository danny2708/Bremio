import type { MemoryEntry, MemoryScope } from "./types";

export interface MemoryQuery {
  scopes?: MemoryScope[];
  tags?: string[];
  sourceKinds?: string[];
  ids?: string[];
  limit?: number;
}

export interface MemoryStore {
  store(entry: MemoryEntry): Promise<void>;
  get(id: string): Promise<MemoryEntry | undefined>;
  query(filter: MemoryQuery): Promise<MemoryEntry[]>;
  delete(id: string): Promise<boolean>;
  list(scope: MemoryScope): Promise<MemoryEntry[]>;
}

export class InMemoryStore implements MemoryStore {
  private readonly entries = new Map<string, MemoryEntry>();

  async store(entry: MemoryEntry): Promise<void> {
    this.entries.set(entry.id, { ...entry });
  }

  async get(id: string): Promise<MemoryEntry | undefined> {
    const entry = this.entries.get(id);
    return entry ? { ...entry } : undefined;
  }

  async query(filter: MemoryQuery): Promise<MemoryEntry[]> {
    let results = [...this.entries.values()];
    if (filter.scopes && filter.scopes.length > 0) {
      results = results.filter((e) => filter.scopes!.includes(e.scope));
    }
    if (filter.tags && filter.tags.length > 0) {
      results = results.filter((e) => filter.tags!.some((t) => e.tags.includes(t)));
    }
    if (filter.sourceKinds && filter.sourceKinds.length > 0) {
      results = results.filter((e) => filter.sourceKinds!.includes(e.source.kind));
    }
    if (filter.ids && filter.ids.length > 0) {
      results = results.filter((e) => filter.ids!.includes(e.id));
    }
    if (filter.limit !== undefined && filter.limit >= 0) {
      results = results.slice(0, filter.limit);
    }
    return results.map((e) => ({ ...e }));
  }

  async delete(id: string): Promise<boolean> {
    return this.entries.delete(id);
  }

  async list(scope: MemoryScope): Promise<MemoryEntry[]> {
    return this.query({ scopes: [scope] });
  }
}
