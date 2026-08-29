export type MemoryScope = "session" | "project" | "user";

export type MemorySource =
  | { kind: "session"; sessionId: string; runId?: string }
  | { kind: "manual" }
  | { kind: "proposal" }
  | { kind: "import" };

export type MemoryVisibility = "ephemeral" | "shared" | "private";

export type MemoryPersistence = "transient" | "persistent";

export interface ScopeConfig {
  scope: MemoryScope;
  visibility: MemoryVisibility;
  persistence: MemoryPersistence;
  storageDir: string;
}

export const SCOPE_CONFIG: Record<MemoryScope, ScopeConfig> = {
  session: {
    scope: "session",
    visibility: "ephemeral",
    persistence: "transient",
    storageDir: "",
  },
  project: {
    scope: "project",
    visibility: "shared",
    persistence: "persistent",
    storageDir: ".bremio/memory/project",
  },
  user: {
    scope: "user",
    visibility: "private",
    persistence: "persistent",
    storageDir: "memory/user",
  },
};

export function getScopeConfig(scope: MemoryScope): ScopeConfig {
  const cfg = SCOPE_CONFIG[scope];
  if (!cfg) throw new Error(`Unknown memory scope: ${scope}`);
  return cfg;
}

export function resolveStorageDir(scope: MemoryScope): string {
  return getScopeConfig(scope).storageDir;
}

export type MemoryReviewState = "pending" | "approved" | "rejected";

export interface MemoryReviewInfo {
  state: MemoryReviewState;
  reviewer?: string;
  reviewedAt?: string;
  note?: string;
}

export interface MemoryEntry {
  id: string;
  scope: MemoryScope;
  source: MemorySource;
  title: string;
  content: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
  metadata: Record<string, unknown>;
  repository?: string;
  visibility?: MemoryVisibility;
  review?: MemoryReviewInfo;
}
