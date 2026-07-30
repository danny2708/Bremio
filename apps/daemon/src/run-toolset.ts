import { evaluate, type ControlMode } from "@bremio/policy";
import {
  CommandTool,
  WebSearchTool,
  McpPermissionGuard,
  HookManager,
  SkillManager,
} from "@bremio/adapter-sdk";
import type { ProcessSupervisor } from "@bremio/adapter-sdk";

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
 * All Sprint 8 tools are constructed here with real policy bindings, but no
 * adapter currently calls them — they remain inert at the production call
 * sites until Sprint 9+ work adds consumers. The infrastructure (per-run
 * construction, real evaluate(), approval gating) is in place and tested.
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

  createWebSearchTool(): WebSearchTool {
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
    });
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
