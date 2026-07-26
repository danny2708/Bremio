import { randomUUID, createHash } from "node:crypto";
import type { ActionClass } from "@bremio/policy";

export type RiskLevel = "low" | "medium" | "high";

export type GrantScope = "once" | "session" | "workspace";

export type ApprovalRequestState =
  | "pending"
  | "approved"
  | "rejected"
  | "expired"
  | "cancelled";

export interface ActionDigest {
  actionClass: ActionClass;
  /** The specific target, e.g. file path, command string, URL. */
  target: string;
  /** Human-readable description of the action. */
  description: string;
  /** SHA-256 hex digest of the canonical serialization. */
  digest: string;
}

export namespace ActionDigest {
  const SEP = "\0";

  function canonical(actionClass: ActionClass, target: string): string {
    return `${actionClass}${SEP}${target}`;
  }

  export function create(
    actionClass: ActionClass,
    target: string,
    description: string,
  ): ActionDigest {
    const canon = canonical(actionClass, target);
    const digest = createHash("sha256").update(canon, "utf-8").digest("hex");
    return { actionClass, target, description, digest };
  }

  export function verify(digest: ActionDigest): boolean {
    const canon = canonical(digest.actionClass, digest.target);
    const expected = createHash("sha256").update(canon, "utf-8").digest("hex");
    return digest.digest === expected;
  }
}

export interface ApprovalRequest {
  id: string;
  sessionId: string;
  runId: string;
  actionDigest: ActionDigest;
  risk: RiskLevel;
  state: ApprovalRequestState;
  requestedAt: string;
  decidedAt?: string;
  decidedBy?: string;
  reason?: string;
}

export interface ApprovalDecision {
  requestId: string;
  decision: "approved" | "rejected";
  decidedBy: string;
  decidedAt: string;
  reason?: string;
}

export interface NewApprovalGrantParams {
  sessionId: string;
  /** Required for workspace-scoped grants — the workspace the grant covers. */
  workspaceId?: string;
  scope: GrantScope;
  actionClass?: ActionClass;
  target?: string;
  ttlMs: number;
  createdBy: string;
  precedence: number;
  originatingActionDigest?: ActionDigest;
}

export type GrantStatus = "active" | "consumed" | "revoked" | "expired";

export function getGrantStatus(grant: ApprovalGrant): GrantStatus {
  if (grant.revokedAt) return "revoked";
  if (grant.consumedAt) return "consumed";
  if (new Date(grant.expiresAt).getTime() <= Date.now()) return "expired";
  return "active";
}

export interface ApprovalGrant {
  id: string;
  sessionId: string;
  /** The workspace the grant covers; only meaningful for workspace-scoped grants. */
  workspaceId?: string;
  scope: GrantScope;
  actionClass?: ActionClass;
  target?: string;
  expiresAt: string;
  revokedAt?: string;
  /** When a once-scoped grant was used. */
  consumedAt?: string;
  createdAt: string;
  createdBy: string;
  originatingDigest?: string;
  precedence: number;
}

export type ApprovalEventType =
  | "request-created"
  | "request-decided"
  | "request-expired"
  | "request-cancelled"
  | "grant-created"
  | "grant-revoked"
  | "grant-consumed";

export interface ApprovalEvent {
  type: ApprovalEventType;
  timestamp: string;
  requestId?: string;
  grantId?: string;
  data: Record<string, unknown>;
}

export class DuplicateDecisionError extends Error {
  readonly requestId: string;
  readonly currentState: ApprovalRequestState;
  constructor(requestId: string, state: ApprovalRequestState) {
    super(`Request ${requestId} is already ${state}; first-decision-wins`);
    this.name = "DuplicateDecisionError";
    this.requestId = requestId;
    this.currentState = state;
  }
}

export class InvalidTransitionError extends Error {
  constructor(
    readonly requestId: string,
    readonly from: ApprovalRequestState,
    readonly to: ApprovalRequestState,
  ) {
    super(`Cannot transition request ${requestId} from ${from} to ${to}`);
    this.name = "InvalidTransitionError";
  }
}

export class GrantExpiredError extends Error {
  readonly grantId: string;
  constructor(grantId: string) {
    super(`Grant ${grantId} has expired`);
    this.name = "GrantExpiredError";
    this.grantId = grantId;
  }
}

export class GrantAlreadyRevokedError extends Error {
  readonly grantId: string;
  constructor(grantId: string) {
    super(`Grant ${grantId} is already revoked`);
    this.name = "GrantAlreadyRevokedError";
    this.grantId = grantId;
  }
}

export class GrantAlreadyConsumedError extends Error {
  readonly grantId: string;
  constructor(grantId: string) {
    super(`Grant ${grantId} is already consumed`);
    this.name = "GrantAlreadyConsumedError";
    this.grantId = grantId;
  }
}

export class InvalidDigestError extends Error {
  constructor(readonly digest: ActionDigest) {
    super("Action digest verification failed — action may have been tampered with");
    this.name = "InvalidDigestError";
  }
}

type TransitionMap = Record<ApprovalRequestState, ApprovalRequestState[]>;

const ALLOWED_TRANSITIONS: TransitionMap = {
  pending: ["approved", "rejected", "expired", "cancelled"],
  approved: [],
  rejected: [],
  expired: [],
  cancelled: [],
};

function assertTransition(
  id: string,
  from: ApprovalRequestState,
  to: ApprovalRequestState,
): void {
  const allowed = ALLOWED_TRANSITIONS[from];
  if (!allowed.includes(to)) {
    throw new InvalidTransitionError(id, from, to);
  }
}

function nowISO(): string {
  return new Date().toISOString();
}

export class InMemoryApprovalEngine {
  private readonly requests = new Map<string, ApprovalRequest>();
  private readonly grants = new Map<string, ApprovalGrant>();
  private readonly events: ApprovalEvent[] = [];
  private readonly listeners: Array<(event: ApprovalEvent) => void> = [];

  // ── Lifecycle ────────────────────────────────────────────────────

  onEvent(listener: (event: ApprovalEvent) => void): () => void {
    this.listeners.push(listener);
    return () => {
      const idx = this.listeners.indexOf(listener);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }

  private emit(event: ApprovalEvent): void {
    this.events.push(event);
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  get eventLog(): readonly ApprovalEvent[] {
    return this.events;
  }

  // ── Action digest ────────────────────────────────────────────────

  verifyDigest(digest: ActionDigest): boolean {
    return ActionDigest.verify(digest);
  }

  // ── Requests ─────────────────────────────────────────────────────

  createRequest(params: {
    sessionId: string;
    runId: string;
    actionDigest: ActionDigest;
    risk: RiskLevel;
  }): ApprovalRequest {
    if (!ActionDigest.verify(params.actionDigest)) {
      throw new InvalidDigestError(params.actionDigest);
    }

    const request: ApprovalRequest = {
      id: randomUUID(),
      sessionId: params.sessionId,
      runId: params.runId,
      actionDigest: params.actionDigest,
      risk: params.risk,
      state: "pending",
      requestedAt: nowISO(),
    };

    this.requests.set(request.id, request);

    this.emit({
      type: "request-created",
      timestamp: request.requestedAt,
      requestId: request.id,
      data: {
        sessionId: request.sessionId,
        runId: request.runId,
        actionClass: request.actionDigest.actionClass,
        target: request.actionDigest.target,
        risk: request.risk,
      },
    });

    return request;
  }

  decide(decision: ApprovalDecision): ApprovalRequest {
    const req = this.requests.get(decision.requestId);
    if (!req) {
      throw new Error(`ApprovalRequest ${decision.requestId} not found`);
    }

    if (req.state === "approved" || req.state === "rejected") {
      throw new DuplicateDecisionError(req.id, req.state);
    }

    assertTransition(req.id, req.state, decision.decision);

    req.state = decision.decision;
    req.decidedAt = decision.decidedAt;
    req.decidedBy = decision.decidedBy;
    req.reason = decision.reason;

    this.emit({
      type: "request-decided",
      timestamp: decision.decidedAt,
      requestId: req.id,
      data: {
        decision: req.state,
        decidedBy: req.decidedBy,
        reason: req.reason,
      },
    });

    return req;
  }

  cancelRequest(requestId: string): ApprovalRequest {
    const req = this.requests.get(requestId);
    if (!req) {
      throw new Error(`ApprovalRequest ${requestId} not found`);
    }

    assertTransition(req.id, req.state, "cancelled");

    req.state = "cancelled";
    req.decidedAt = nowISO();

    this.emit({
      type: "request-cancelled",
      timestamp: req.decidedAt,
      requestId: req.id,
      data: {},
    });

    return req;
  }

  expirePendingRequests(olderThanMs?: number): number {
    const now = Date.now();
    let count = 0;

    for (const req of this.requests.values()) {
      if (req.state !== "pending") continue;

      const requestedAt = new Date(req.requestedAt).getTime();
      const age = now - requestedAt;

      if (olderThanMs === undefined || age >= olderThanMs) {
        req.state = "expired";
        req.decidedAt = nowISO();
        count++;

        this.emit({
          type: "request-expired",
          timestamp: req.decidedAt,
          requestId: req.id,
          data: { ageMs: age },
        });
      }
    }

    return count;
  }

  getRequest(requestId: string): ApprovalRequest | undefined {
    return this.requests.get(requestId);
  }

  getRequestsBySession(sessionId: string): ApprovalRequest[] {
    const result: ApprovalRequest[] = [];
    for (const req of this.requests.values()) {
      if (req.sessionId === sessionId) {
        result.push(req);
      }
    }
    return result;
  }

  // ── Grants ───────────────────────────────────────────────────────

  createGrant(params: NewApprovalGrantParams): ApprovalGrant {
    const expiresAt = new Date(Date.now() + params.ttlMs).toISOString();

    const grant: ApprovalGrant = {
      id: randomUUID(),
      sessionId: params.sessionId,
      workspaceId: params.workspaceId,
      scope: params.scope,
      actionClass: params.actionClass,
      target: params.target,
      expiresAt,
      createdAt: nowISO(),
      createdBy: params.createdBy,
      originatingDigest: params.originatingActionDigest?.digest,
      precedence: params.precedence,
    };

    this.grants.set(grant.id, grant);

    this.emit({
      type: "grant-created",
      timestamp: grant.createdAt,
      grantId: grant.id,
      data: {
        sessionId: grant.sessionId,
        scope: grant.scope,
        actionClass: grant.actionClass,
        target: grant.target,
        precedence: grant.precedence,
      },
    });

    return grant;
  }

  revokeGrant(grantId: string): ApprovalGrant {
    const grant = this.grants.get(grantId);
    if (!grant) {
      throw new Error(`ApprovalGrant ${grantId} not found`);
    }
    const status = getGrantStatus(grant);
    if (status === "revoked") {
      throw new GrantAlreadyRevokedError(grantId);
    }
    if (status === "consumed") {
      throw new GrantAlreadyConsumedError(grantId);
    }

    grant.revokedAt = nowISO();

    this.emit({
      type: "grant-revoked",
      timestamp: grant.revokedAt,
      grantId: grant.id,
      data: {
        sessionId: grant.sessionId,
        scope: grant.scope,
      },
    });

    return grant;
  }

  consumeGrant(grantId: string): ApprovalGrant {
    const grant = this.grants.get(grantId);
    if (!grant) {
      throw new Error(`ApprovalGrant ${grantId} not found`);
    }
    const status = getGrantStatus(grant);
    if (status === "consumed") {
      throw new GrantAlreadyConsumedError(grantId);
    }
    if (status === "revoked") {
      throw new GrantAlreadyRevokedError(grantId);
    }

    grant.consumedAt = nowISO();

    this.emit({
      type: "grant-consumed",
      timestamp: grant.consumedAt,
      grantId: grant.id,
      data: {
        sessionId: grant.sessionId,
        scope: grant.scope,
      },
    });

    return grant;
  }

  findActiveGrant(
    sessionId: string,
    actionClass: ActionClass,
    target?: string,
    workspaceId?: string,
  ): ApprovalGrant | null {
    const now = Date.now();
    const candidates: ApprovalGrant[] = [];

    for (const grant of this.grants.values()) {
      const status = getGrantStatus(grant);
      if (status !== "active") continue;

      // Session-scoped: exact session match.
      // Workspace-scoped: matches any session in the same workspace.
      if (grant.scope === "session" && grant.sessionId !== sessionId) continue;
      if (grant.scope === "workspace") {
        if (grant.workspaceId === undefined) continue;
        if (grant.sessionId !== sessionId && (workspaceId === undefined || grant.workspaceId !== workspaceId)) continue;
      }
      // Once-scoped: matches the session that owns it.
      if (grant.scope === "once" && grant.sessionId !== sessionId) continue;

      if (grant.actionClass !== undefined && grant.actionClass !== actionClass) continue;
      if (grant.target !== undefined && target !== undefined && grant.target !== target) continue;

      candidates.push(grant);
    }

    if (candidates.length === 0) return null;

    candidates.sort((a, b) => {
      const prec = b.precedence - a.precedence;
      if (prec !== 0) return prec;
      return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    });

    return candidates[0] ?? null;
  }

  getGrant(grantId: string): ApprovalGrant | undefined {
    return this.grants.get(grantId);
  }

  getGrantsBySession(sessionId: string): ApprovalGrant[] {
    const result: ApprovalGrant[] = [];
    for (const grant of this.grants.values()) {
      if (grant.sessionId === sessionId) {
        result.push(grant);
      }
    }
    return result;
  }

  getGrantsByWorkspace(workspaceId: string): ApprovalGrant[] {
    const result: ApprovalGrant[] = [];
    for (const grant of this.grants.values()) {
      if (grant.workspaceId === workspaceId) {
        result.push(grant);
      }
    }
    return result;
  }

  revokeSessionGrants(sessionId: string): number {
    let count = 0;
    for (const grant of this.grants.values()) {
      if (grant.sessionId !== sessionId) continue;
      if (getGrantStatus(grant) !== "active") continue;
      this.revokeGrant(grant.id);
      count++;
    }
    return count;
  }

  revokeWorkspaceGrants(workspaceId: string): number {
    let count = 0;
    for (const grant of this.grants.values()) {
      if (grant.scope !== "workspace") continue;
      if (grant.workspaceId !== workspaceId) continue;
      if (getGrantStatus(grant) !== "active") continue;
      this.revokeGrant(grant.id);
      count++;
    }
    return count;
  }

  pruneExpiredGrants(): number {
    const now = Date.now();
    let count = 0;

    for (const [id, grant] of this.grants) {
      if (getGrantStatus(grant) === "expired") {
        this.grants.delete(id);
        count++;
      }
    }

    return count;
  }
}
