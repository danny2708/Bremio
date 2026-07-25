import path from "node:path";
import { daemonStatus } from "@bremio/daemon";
import { c, statusGlyph } from "./ui";

/* ------------------------------------------------------------------ */
/*  Shared helper — make a daemon HTTP call                           */
/* ------------------------------------------------------------------ */

async function daemonCall<T>(
  route: string,
  init: RequestInit = {},
): Promise<{ ok: true; data: T } | { ok: false; status: number; text: string }> {
  const status = await daemonStatus();
  if (!status.running) {
    throw new Error("daemon is not running — start it with `bremio daemon start`");
  }
  const res = await fetch(`http://127.0.0.1:${status.endpoint.port}${route}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-bremio-token": status.endpoint.token,
      ...(init.headers as Record<string, string>),
    },
  });
  const text = await res.text();
  if (!res.ok) return { ok: false, status: res.status, text };
  return { ok: true, data: JSON.parse(text) as T };
}

/* ------------------------------------------------------------------ */
/*  Request sub-commands                                               */
/* ------------------------------------------------------------------ */

async function listRequests(options: {
  sessionId?: string;
  runId?: string;
  state?: string;
  json?: boolean;
}): Promise<number> {
  const params = new URLSearchParams();
  if (options.sessionId) params.set("sessionId", options.sessionId);
  if (options.runId) params.set("runId", options.runId);
  if (options.state) params.set("state", options.state);
  const qs = params.toString();

  const result = await daemonCall<{ requests: unknown[] }>(`/approval/requests${qs ? `?${qs}` : ""}`);
  if (!result.ok) {
    console.error(c.red(`error: ${result.text}`));
    return 1;
  }

  if (options.json) {
    console.log(JSON.stringify({ requests: result.data.requests }, null, 2));
    return 0;
  }

  const requests = result.data.requests;
  if (requests.length === 0) {
    console.log(c.dim("No approval requests found."));
    return 0;
  }

  const line = "─".repeat(72);
  console.log(`\n${line}`);
  console.log(` ${c.bold("Approval requests")}  ${c.dim(String(requests.length))}`);
  console.log(line);
  for (const r of requests) {
    const req = r as Record<string, unknown>;
    const stateStr = requestStateGlyph(String(req.state));
    const riskStr = riskGlyph(String(req.risk ?? "low"));
    console.log(
      `  ${c.cyan(String(req.id))}  ${stateStr}  ${riskStr}  ` +
        `${c.dim(String(req.actionClass ?? ""))}  ${String(req.actionTarget ?? "").slice(0, 50)}`,
    );
    if (req.actionDescription) {
      console.log(`    ${c.dim(String(req.actionDescription).slice(0, 72))}`);
    }
    if (req.reason) {
      console.log(`    ${c.yellow(`reason: ${req.reason}`)}`);
    }
  }
  console.log(line);
  return 0;
}

async function showRequest(options: { id: string; json?: boolean }): Promise<number> {
  if (!options.id) {
    console.error(c.red("error: request id is required"));
    return 1;
  }

  const result = await daemonCall<{ request: Record<string, unknown> }>(
    `/approval/requests/${encodeURIComponent(options.id)}`,
  );
  if (!result.ok) {
    if (result.status === 404) {
      console.error(c.red(`error: unknown approval request: ${options.id}`));
      return 1;
    }
    console.error(c.red(`error: ${result.text}`));
    return 1;
  }

  if (options.json) {
    console.log(JSON.stringify({ request: result.data.request }, null, 2));
    return 0;
  }

  const r = result.data.request;
  const line = "─".repeat(60);
  console.log(`\n${line}`);
  console.log(` ${c.bold("Approval request")}  ${c.cyan(String(r.id))}`);
  console.log(line);
  console.log(`  state:      ${requestStateGlyph(String(r.state))}`);
  console.log(`  action:     ${c.dim(String(r.actionClass ?? ""))}  ${String(r.actionTarget ?? "")}`);
  if (r.actionDescription) console.log(`  desc:       ${String(r.actionDescription)}`);
  console.log(`  risk:       ${riskGlyph(String(r.risk ?? "low"))}`);
  console.log(`  session:    ${c.dim(String(r.sessionId ?? ""))}`);
  console.log(`  run:        ${c.dim(String(r.runId ?? ""))}`);
  console.log(`  requested:  ${c.dim(String(r.requestedAt ?? ""))}`);
  if (r.decidedAt) console.log(`  decided:    ${c.dim(String(r.decidedAt))}`);
  if (r.decidedBy) console.log(`  decided by: ${c.dim(String(r.decidedBy))}`);
  if (r.reason) console.log(`  reason:     ${String(r.reason)}`);
  console.log(line);
  return 0;
}

async function decideRequest(
  id: string,
  decision: "approved" | "rejected",
  options: { reason?: string; decidedBy?: string; json?: boolean },
): Promise<number> {
  if (!id) {
    console.error(c.red(`error: request id is required for 'bremio approval ${decision} <id>'`));
    return 2;
  }

  const result = await daemonCall<{ request: Record<string, unknown> }>(
    `/approval/requests/${encodeURIComponent(id)}/decide`,
    {
      method: "POST",
      body: JSON.stringify({
        decision,
        decidedBy: options.decidedBy ?? "cli",
        ...(options.reason ? { reason: options.reason } : {}),
      }),
    },
  );
  if (!result.ok) {
    if (result.status === 409) {
      console.error(c.red(`error: request ${id} is not in a pending state`));
      return 1;
    }
    console.error(c.red(`error: ${result.text}`));
    return 1;
  }

  if (options.json) {
    console.log(JSON.stringify({ request: result.data.request }, null, 2));
    return 0;
  }

  const r = result.data.request;
  const verb = decision === "approved" ? c.green("Approved") : c.red("Rejected");
  console.log(`${verb} request ${c.cyan(id)}`);
  if (r.reason) console.log(`  reason: ${r.reason}`);
  return 0;
}

async function cancelRequest(options: { id: string; json?: boolean }): Promise<number> {
  if (!options.id) {
    console.error(c.red("error: request id is required for 'bremio approval cancel <id>'"));
    return 2;
  }

  const result = await daemonCall<{ request: Record<string, unknown> }>(
    `/approval/requests/${encodeURIComponent(options.id)}/cancel`,
    { method: "POST" },
  );
  if (!result.ok) {
    if (result.status === 409) {
      console.error(c.red(`error: request ${options.id} is not in a pending state`));
      return 1;
    }
    console.error(c.red(`error: ${result.text}`));
    return 1;
  }

  if (options.json) {
    console.log(JSON.stringify({ request: result.data.request }, null, 2));
    return 0;
  }

  console.log(`${c.yellow("Cancelled")} request ${c.cyan(options.id)}`);
  return 0;
}

/* ------------------------------------------------------------------ */
/*  Grant sub-commands                                                 */
/* ------------------------------------------------------------------ */

async function listGrants(options: {
  sessionId?: string;
  workspaceId?: string;
  scope?: string;
  json?: boolean;
}): Promise<number> {
  const params = new URLSearchParams();
  if (options.sessionId) params.set("sessionId", options.sessionId);
  if (options.workspaceId) params.set("workspaceId", options.workspaceId);
  if (options.scope) params.set("scope", options.scope);
  const qs = params.toString();

  const result = await daemonCall<{ grants: unknown[] }>(`/approval/grants${qs ? `?${qs}` : ""}`);
  if (!result.ok) {
    console.error(c.red(`error: ${result.text}`));
    return 1;
  }

  if (options.json) {
    console.log(JSON.stringify({ grants: result.data.grants }, null, 2));
    return 0;
  }

  const grants = result.data.grants;
  if (grants.length === 0) {
    console.log(c.dim("No approval grants found."));
    return 0;
  }

  const line = "─".repeat(72);
  console.log(`\n${line}`);
  console.log(` ${c.bold("Approval grants")}  ${c.dim(String(grants.length))}`);
  console.log(line);
  for (const g of grants) {
    const grant = g as Record<string, unknown>;
    const scopeStr = c.cyan(String(grant.scope ?? ""));
    const actionStr = grant.actionClass ? c.dim(String(grant.actionClass)) : c.dim("(any)");
    const expires = grant.expiresAt ? new Date(String(grant.expiresAt)).toLocaleString() : "";
    console.log(`  ${c.cyan(String(grant.id))}  ${scopeStr}  ${actionStr}  ${c.dim(expires)}`);
    if (grant.target) console.log(`    target: ${c.dim(String(grant.target))}`);
  }
  console.log(line);
  return 0;
}

async function createGrant(options: {
  sessionId?: string;
  workspaceId?: string;
  scope: string;
  actionClass?: string;
  target?: string;
  ttlMs: number;
  createdBy?: string;
  precedence?: number;
  json?: boolean;
}): Promise<number> {
  const body: Record<string, unknown> = {
    sessionId: options.sessionId ?? "cli",
    scope: options.scope,
    ttlMs: options.ttlMs,
    createdBy: options.createdBy ?? "cli",
    precedence: options.precedence ?? 1,
  };
  if (options.workspaceId) body.workspaceId = options.workspaceId;
  if (options.actionClass) body.actionClass = options.actionClass;
  if (options.target) body.target = options.target;

  const result = await daemonCall<{ grant: Record<string, unknown> }>("/approval/grants", {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!result.ok) {
    console.error(c.red(`error: ${result.text}`));
    return 1;
  }

  if (options.json) {
    console.log(JSON.stringify({ grant: result.data.grant }, null, 2));
    return 0;
  }

  const grant = result.data.grant;
  console.log(`${c.green("Created")} grant ${c.cyan(String(grant.id))}`);
  console.log(`  scope:      ${c.cyan(String(grant.scope))}`);
  console.log(`  expires:    ${c.dim(String(grant.expiresAt ?? ""))}`);
  if (grant.actionClass) console.log(`  action:     ${String(grant.actionClass)}`);
  if (grant.target) console.log(`  target:     ${String(grant.target)}`);
  return 0;
}

async function revokeGrant(options: { id: string; json?: boolean }): Promise<number> {
  if (!options.id) {
    console.error(c.red("error: grant id is required for 'bremio approval grants revoke <id>'"));
    return 2;
  }

  const result = await daemonCall<{ grant: Record<string, unknown> }>(
    `/approval/grants/${encodeURIComponent(options.id)}/revoke`,
    { method: "POST" },
  );
  if (!result.ok) {
    if (result.status === 409) {
      console.error(c.red(`error: grant ${options.id} is not active`));
      return 1;
    }
    console.error(c.red(`error: ${result.text}`));
    return 1;
  }

  if (options.json) {
    console.log(JSON.stringify({ grant: result.data.grant }, null, 2));
    return 0;
  }

  console.log(`${c.yellow("Revoked")} grant ${c.cyan(options.id)}`);
  return 0;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function requestStateGlyph(state: string): string {
  switch (state) {
    case "pending":  return c.yellow("◷ pending");
    case "approved": return c.green("✓ approved");
    case "rejected": return c.red("✗ rejected");
    case "cancelled": return c.yellow("◼ cancelled");
    case "expired":  return c.dim("◷ expired");
    default:         return state;
  }
}

function riskGlyph(risk: string): string {
  switch (risk) {
    case "high":   return c.red("⚑ high");
    case "medium": return c.yellow("⚐ medium");
    case "low":    return c.dim("⚐ low");
    default:       return risk;
  }
}

function printUsage(): void {
  console.log(`Usage: bremio approval <subcommand> [options]

Subcommands:
  list [--session <id>] [--run <id>] [--state <s>]
                           List approval requests
  show <id>                Show a single approval request
  approve <id> [--reason <text>]
                           Approve a pending request
  reject <id> [--reason <text>]
                           Reject a pending request
  cancel <id>              Cancel a pending request

  grants list [--session <id>] [--workspace <id>] [--scope <s>]
                           List approval grants
  grants create --scope <s> --ttl <ms> [options]
                           Create an approval grant
  grants revoke <id>       Revoke an active grant

Options:
  --json                   Output as JSON
  --decided-by <name>      Who is making the decision (default: cli)
  --session <id>           Filter by session
  --run <id>               Filter by run
  --state <s>              Filter by state (pending|approved|rejected|...)
  --workspace <id>         Workspace ID for grants
  --scope <s>              Grant scope (once|session|workspace)
  --ttl <ms>               Grant time-to-live in milliseconds
  --action-class <c>       Action class restriction for grant
  --target <t>             Target restriction for grant
  --precedence <n>         Grant precedence (default: 1)`);
}

/* ------------------------------------------------------------------ */
/*  Entry point                                                        */
/* ------------------------------------------------------------------ */

export async function approvalCommandFromCli(
  values: Record<string, unknown>,
  positionals: string[],
): Promise<number> {
  const subCommand = positionals[1];

  if (!subCommand || subCommand === "--help" || subCommand === "-h") {
    printUsage();
    return 0;
  }

  const json = values.json === true;

  if (subCommand === "list") {
    return listRequests({
      sessionId: values.session as string | undefined,
      runId: values.run as string | undefined,
      state: values.state as string | undefined,
      json,
    });
  }

  if (subCommand === "show") {
    return showRequest({ id: positionals[2] ?? "", json });
  }

  if (subCommand === "approve" || subCommand === "reject") {
    const decision = subCommand === "approve" ? "approved" : "rejected";
    return decideRequest(positionals[2] ?? "", decision, {
      reason: values.reason as string | undefined,
      decidedBy: values["decided-by"] as string | undefined,
      json,
    });
  }

  if (subCommand === "cancel") {
    return cancelRequest({ id: positionals[2] ?? "", json });
  }

  if (subCommand === "grants") {
    const grantSub = positionals[2];
    if (!grantSub) {
      console.error(c.red("error: expected 'list', 'create', or 'revoke'"));
      return 2;
    }

    if (grantSub === "list") {
      return listGrants({
        sessionId: values.session as string | undefined,
        workspaceId: values.workspace as string | undefined,
        scope: values.scope as string | undefined,
        json,
      });
    }

    if (grantSub === "create") {
      const scope = values.scope as string | undefined;
      const ttlStr = values.ttl as string | undefined;
      if (!scope || !ttlStr) {
        console.error(c.red("error: --scope and --ttl <ms> are required for 'grants create'"));
        return 2;
      }
      const ttlMs = Number(ttlStr);
      if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
        console.error(c.red("error: --ttl must be a positive number"));
        return 2;
      }
      return createGrant({
        sessionId: values.session as string | undefined,
        workspaceId: values.workspace as string | undefined,
        scope,
        actionClass: values["action-class"] as string | undefined,
        target: values.target as string | undefined,
        ttlMs,
        createdBy: values["decided-by"] as string | undefined,
        precedence: values.precedence !== undefined ? Number(values.precedence) : undefined,
        json,
      });
    }

    if (grantSub === "revoke") {
      return revokeGrant({ id: positionals[3] ?? "", json });
    }

    console.error(c.red(`error: unknown grants subcommand '${grantSub}'; expected 'list', 'create', or 'revoke'`));
    return 2;
  }

  console.error(c.red(`error: unknown approval subcommand '${subCommand}'`));
  printUsage();
  return 2;
}
