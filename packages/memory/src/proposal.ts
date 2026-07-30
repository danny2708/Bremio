import type { MemoryEntry, MemoryScope, MemorySource } from "./types";
import type { MemoryStore } from "./store";

export interface ProposalReviewInput {
  decision: "accept" | "reject";
  reviewer?: string;
  notes?: string;
  targetSource?: MemorySource;
}

export class MemoryProposalLifecycle {
  constructor(private readonly store: MemoryStore) {}

  async propose(entry: MemoryEntry, proposedBy?: string): Promise<void> {
    const proposal: MemoryEntry = {
      ...entry,
      source: { kind: "proposal" },
      metadata: {
        ...entry.metadata,
        reviewStatus: "pending",
        ...(proposedBy ? { proposedBy } : {}),
      },
    };
    await this.store.store(proposal);
  }

  async listProposals(scope?: MemoryScope): Promise<MemoryEntry[]> {
    const entries = scope
      ? await this.store.list(scope)
      : await this.store.query({ sourceKinds: ["proposal"] });
    return entries.filter((e) => e.metadata?.reviewStatus === "pending");
  }

  async review(id: string, input: ProposalReviewInput): Promise<void> {
    const entry = await this.store.get(id);
    if (!entry) throw new Error(`Proposal not found: ${id}`);
    if (entry.source.kind !== "proposal") {
      throw new Error(`Entry ${id} is not a proposal`);
    }
    if (entry.metadata.reviewStatus !== "pending") {
      throw new Error(`Proposal ${id} has already been reviewed`);
    }

    const now = new Date().toISOString();
    const baseMeta = { ...entry.metadata };

    if (input.decision === "accept") {
      // No default. `{ kind: "manual" }` records the *user* as the author of
      // something an agent proposed — the same wrong-actor-in-the-audit-trail
      // defect S7 fixed for auto-compacts, and it contradicts S1-T3's rule
      // that provenance gaps are confirmed rather than filled from a default.
      // The reviewer knows what this entry actually is; make them say it.
      const targetSource = input.targetSource;
      if (!targetSource) {
        throw new Error(
          `accepting proposal ${id} requires an explicit targetSource: its provenance cannot be assumed`,
        );
      }
      const accepted: MemoryEntry = {
        ...entry,
        source: targetSource,
        updatedAt: now,
        metadata: {
          ...baseMeta,
          reviewStatus: "accepted",
          reviewedAt: now,
          reviewedBy: input.reviewer,
          reviewNotes: input.notes,
        },
      };
      await this.store.store(accepted);
    } else {
      const rejected: MemoryEntry = {
        ...entry,
        updatedAt: now,
        metadata: {
          ...baseMeta,
          reviewStatus: "rejected",
          reviewedAt: now,
          reviewedBy: input.reviewer,
          reviewNotes: input.notes,
        },
      };
      await this.store.store(rejected);
    }
  }
}
