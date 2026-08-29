import type { AgentEvent, RuntimeGuardDecision, RuntimeGuardLevel, RuntimeGuardAction, EvidenceQuality } from "@bremio/protocol";
import type { AdapterRuntimeCapabilities } from "@bremio/adapter-sdk";

export interface GuardConfig {
  maxConsecutiveErrors: number;
  maxConsecutiveSameTool: number;
  maxTokensPerMinute: number;
  noProgressTimeoutMs: number;
}

export const DEFAULT_GUARD_CONFIG: GuardConfig = {
  maxConsecutiveErrors: 5,
  maxConsecutiveSameTool: 5,
  maxTokensPerMinute: 100000,
  noProgressTimeoutMs: 300000, // 5 minutes
};

// Deep equality check without lodash
function isDeepEqual(a: any, b: any): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  
  for (const key of keysA) {
    if (!keysB.includes(key)) return false;
    if (!isDeepEqual(a[key], b[key])) return false;
  }
  return true;
}

export class RuntimeGuardEvaluator {
  private config: GuardConfig;
  private level: RuntimeGuardLevel = "healthy";
  
  private consecutiveErrors = 0;
  private consecutiveSameTool = 0;
  private lastToolCall: { name: string; input?: unknown } | null = null;
  
  private tokensInMinute = 0;
  private minuteStartTimeMs: number | null = null;
  private lastProgressMs: number | null = null;
  
  constructor(
    private runId: string,
    private agentId: string,
    private capabilities: AdapterRuntimeCapabilities,
    config?: Partial<GuardConfig>
  ) {
    this.config = { ...DEFAULT_GUARD_CONFIG, ...config };
  }
  
  evaluate(event: AgentEvent): RuntimeGuardDecision | null {
    const prevLevel = this.level;
    let isHealthyObservation = false;
    let isViolation = false;
    let reason = "";
    let reasonCode = "";
    let evidenceQuality: EvidenceQuality = "observed";

    if (this.minuteStartTimeMs === null) {
      this.minuteStartTimeMs = event.ts;
    } else if (event.ts - this.minuteStartTimeMs > 60000) {
      this.minuteStartTimeMs = event.ts;
      this.tokensInMinute = 0;
    }

    if (this.lastProgressMs === null) {
      this.lastProgressMs = event.ts;
    }

    if (event.type === "error" || (event.type === "tool_result" && !event.ok)) {
      this.consecutiveErrors++;
      if (this.consecutiveErrors >= this.config.maxConsecutiveErrors) {
        isViolation = true;
        reason = "Error storm detected";
        reasonCode = "error-storm";
      }
    } else if (event.type === "message" || event.type === "tool_result") {
      this.consecutiveErrors = 0;
      isHealthyObservation = true;
      this.lastProgressMs = event.ts;
    } else if (event.type === "tool_use") {
      this.lastProgressMs = event.ts;
    }

    if (event.type === "tool_use") {
      if (this.capabilities.structuredToolEvents) {
        if (this.lastToolCall && this.lastToolCall.name === event.name && isDeepEqual(this.lastToolCall.input, event.input)) {
          this.consecutiveSameTool++;
          if (this.consecutiveSameTool >= this.config.maxConsecutiveSameTool) {
            isViolation = true;
            reason = "Repeated identical tool call";
            reasonCode = "repeated-tool";
          }
        } else {
          this.consecutiveSameTool = 1;
          this.lastToolCall = { name: event.name, input: event.input };
        }
      }
    } else if (event.type === "message") {
      // message resets repeated tools
      this.consecutiveSameTool = 0;
      this.lastToolCall = null;
    }

    if (event.type === "usage") {
      if (this.capabilities.contextMetrics === "reported") {
        const inputT = event.inputTokens ?? 0;
        const outputT = event.outputTokens ?? 0;
        this.tokensInMinute += (inputT + outputT);
        if (this.tokensInMinute >= this.config.maxTokensPerMinute) {
          isViolation = true;
          reason = "Excessive token velocity";
          reasonCode = "token-velocity";
          evidenceQuality = "reported";
        }
      }
    }

    // No-progress check
    if (!isHealthyObservation && event.ts - this.lastProgressMs > this.config.noProgressTimeoutMs) {
      isViolation = true;
      reason = "No progress";
      reasonCode = "no-progress";
    }

    let newLevel = this.level;
    if (isViolation) {
      if (this.level === "healthy") newLevel = "warning";
      else if (this.level === "warning") newLevel = "constrained";
      else if (this.level === "constrained") newLevel = "stop-requested";
    } else if (isHealthyObservation && !isViolation) {
      if (this.level === "stop-requested") newLevel = "constrained";
      else if (this.level === "constrained") newLevel = "warning";
      else if (this.level === "warning") newLevel = "healthy";
    }

    if (newLevel !== prevLevel) {
      this.level = newLevel;
      
      let action: RuntimeGuardAction = "none";
      if (newLevel === "warning") action = "warn";
      else if (newLevel === "constrained") action = "suppress-future-work";
      else if (newLevel === "stop-requested") {
        action = this.capabilities.cancellation ? "cancel" : "suppress-future-work";
      }

      if (!isViolation && newLevel === "healthy") {
        reasonCode = "recovered";
        reason = "Run returned to healthy state";
      }

      // If we stepped down but are still warning/constrained, use a generic recovery reason
      if (!isViolation && prevLevel !== newLevel && newLevel !== "healthy") {
        reasonCode = "partial-recovery";
        reason = "Run partially recovered";
      }

      return {
        runId: this.runId,
        agentId: this.agentId,
        level: newLevel,
        action,
        reasonCode,
        reason,
        evidenceQuality,
        observedAt: new Date(event.ts).toISOString()
      };
    }
    
    return null;
  }
}
