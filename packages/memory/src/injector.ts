import type { MemoryEntry, MemoryScope } from "./types";
import type { MemoryStore } from "./store";

export interface MemoryInjectionConfig {
  maxTokens: number;
  scopes?: MemoryScope[];
  tags?: string[];
  maxEntries?: number;
}

export class MemoryInjector {
  constructor(private readonly store: MemoryStore) {}

  estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  estimateEntryTokens(entry: MemoryEntry): number {
    const titleTokens = this.estimateTokens(entry.title);
    const contentTokens = this.estimateTokens(entry.content);
    const overheadTokens = 10;
    return titleTokens + contentTokens + overheadTokens;
  }

  async select(config: MemoryInjectionConfig): Promise<MemoryEntry[]> {
    if (config.maxTokens <= 0) {
      throw new Error("maxTokens must be a positive number");
    }

    const scopes = config.scopes ?? ["project", "user"];

    const candidates: MemoryEntry[] = [];
    for (const scope of scopes) {
      const entries = await this.store.list(scope);
      for (const entry of entries) {
        if (entry.review?.state !== "approved") continue;
        if (entry.expiresAt && new Date(entry.expiresAt) <= new Date()) continue;
        candidates.push(entry);
      }
    }

    if (config.tags && config.tags.length > 0) {
      const filtered = candidates.filter((e) =>
        config.tags!.some((t) => e.tags.includes(t)),
      );
      candidates.length = 0;
      candidates.push(...filtered);
    }

    candidates.sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );

    const selected: MemoryEntry[] = [];
    let usedTokens = 0;

    for (const entry of candidates) {
      const tokens = this.estimateEntryTokens(entry);
      if (usedTokens + tokens <= config.maxTokens) {
        selected.push(entry);
        usedTokens += tokens;
      }
      if (config.maxEntries !== undefined && selected.length >= config.maxEntries) {
        break;
      }
    }

    return selected;
  }

  formatInjection(entries: MemoryEntry[]): string {
    if (entries.length === 0) return "";

    const escape = (s: string): string =>
      s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");

    const parts: string[] = ["<memory>"];
    for (const entry of entries) {
      parts.push(`  <entry scope="${escape(entry.scope)}" title="${escape(entry.title)}">`);
      if (entry.tags.length > 0) {
        parts.push(`    <tags>${escape(entry.tags.join(", "))}</tags>`);
      }
      parts.push(`    <content>${escape(entry.content)}</content>`);
      parts.push("  </entry>");
    }
    parts.push("</memory>");
    return parts.join("\n");
  }
}
