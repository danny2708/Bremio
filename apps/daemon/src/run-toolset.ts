import { evaluate, type ControlMode } from "@bremio/policy";
import {
  CommandTool,
  WebSearchTool,
  McpPermissionGuard,
  HookManager,
  SkillManager,
  resolveWebSearchBackend,
} from "@bremio/adapter-sdk";
import type { ProcessSupervisor, WebSearchBackend } from "@bremio/adapter-sdk";

export interface RunToolsetOptions {
  controlMode: ControlMode;
}

/**
 * A per-run collection of Sprint 8 tools wired to real policy evaluation from
 * `@bremio/policy` via the control-mode matrix, and to the S3 approval
 * lifecycle (approval requirements pass through as gated denials).
 *
 * Tools are constructed lazily through factory methods so callers supply
 * run-specific dependencies (e.g. ProcessSupervisor for CommandTool) without
 * the toolset needing to know what adapters will be used.
 *
 * The approval lifecycle is expressed at the policy layer: when a tool's
 * permission check receives an `approvalRequired` that is not `"none"`,
 * the check returns `{ allowed: false, reason: "requires <type> approval" }`.
 * The run orchestrator is expected to create an S3 approval request before
 * retrying the action. The tool itself is purely a gate and does not manage
 * approval state.
 *
 * MCP, hooks and playbooks now reach agents through the per-run registry
 * wrapper (`prepareRunExtensions`, docs/17 P3-T1…T3), not through this class.
 * The command and web-search tools built here are policy-bound but still not
 * offered to any agent; an agent-callable surface for them is P3-T5.
 */
export class RunToolset {
  readonly hooks: HookManager;
  readonly skills: SkillManager;
  readonly #controlMode: ControlMode;

  constructor(opts: RunToolsetOptions) {
    this.#controlMode = opts.controlMode;
    this.hooks = new HookManager();
    this.skills = new SkillManager(this.hooks);
  }

  createCommandTool(supervisor: ProcessSupervisor): CommandTool {
    return new CommandTool(supervisor, (_actionClass, _command, _args) => {
      const evalResult = evaluate(this.#controlMode, "command");
      if (!evalResult.allowed) {
        return { allowed: false, reason: evalResult.reason };
      }
      if (evalResult.approvalRequired !== "none") {
        return {
          allowed: false,
          reason: `requires ${evalResult.approvalRequired} approval before executing commands`,
        };
      }
      return { allowed: true, reason: "allowed by policy" };
    });
  }

  /**
   * Web search against the configured backend (P3-T4). Without one — the
   * default — the tool answers `unconfigured` and sends nothing.
   */
  createWebSearchTool(
    resolved: { backend: WebSearchBackend } | { reason: string } = resolveWebSearchBackend(),
  ): WebSearchTool {
    const backend = "backend" in resolved ? resolved.backend : undefined;
    const unconfigured = "reason" in resolved ? resolved.reason : undefined;
    return new WebSearchTool((_actionClass, _query, _endpoint) => {
      const evalResult = evaluate(this.#controlMode, "network");
      if (!evalResult.allowed) {
        return { allowed: false, reason: evalResult.reason };
      }
      if (evalResult.approvalRequired !== "none") {
        return {
          allowed: false,
          reason: `requires ${evalResult.approvalRequired} approval before searching the web`,
        };
      }
      return { allowed: true, reason: "allowed by policy" };
    }, backend, undefined, unconfigured);
  }

  createMcpPermissionGuard(): McpPermissionGuard {
    return new McpPermissionGuard((actionClass, _toolName) => {
      const evalResult = evaluate(this.#controlMode, actionClass as import("@bremio/policy").ActionClass);
      return {
        allowed: evalResult.allowed,
        approvalRequired: evalResult.approvalRequired,
        reason: evalResult.allowed ? "allowed by policy" : evalResult.reason,
      };
    });
  }
}
