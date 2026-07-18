import { describe, expect, it } from "vitest";
import {
  boundedRetryPolicy,
  classifyAgentError,
  isRetryableCode,
  type AgentError,
} from "./errors";

function error(code: AgentError["code"], retryAfterMs?: number): AgentError {
  return {
    code,
    message: code,
    retryable: isRetryableCode(code),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  };
}

describe("error classification", () => {
  it("recognizes rate limiting in its common forms", () => {
    expect(classifyAgentError(new Error("429 Too Many Requests")).code).toBe("rate_limited");
    expect(classifyAgentError(new Error("rate limit exceeded")).code).toBe("rate_limited");
    expect(classifyAgentError(new Error("Slow down")).code).toBe("rate_limited");
  });

  it("separates quota exhaustion from rate limiting", () => {
    // Both mention limits, but only one is worth waiting out.
    const quota = classifyAgentError(new Error("monthly usage limit reached"));
    expect(quota.code).toBe("quota_exhausted");
    expect(quota.retryable).toBe(false);
  });

  it("never retries an authentication failure", () => {
    const auth = classifyAgentError(new Error("401 Unauthorized: invalid api key"));
    expect(auth.code).toBe("authentication_failed");
    // Retrying cannot fix credentials; it only delays telling the user.
    expect(auth.retryable).toBe(false);
  });

  it("never retries a cancellation", () => {
    const cancelled = classifyAgentError(new Error("The operation was aborted"));
    expect(cancelled.code).toBe("cancelled");
    expect(cancelled.retryable).toBe(false);
  });

  it("treats connection failures and timeouts as retryable", () => {
    expect(classifyAgentError(new Error("connect ECONNREFUSED")).retryable).toBe(true);
    expect(classifyAgentError(new Error("request timed out")).retryable).toBe(true);
    expect(classifyAgentError(new Error("503 Service Unavailable")).retryable).toBe(true);
  });

  it("leaves an unrecognized failure unknown and non-retryable", () => {
    // Optimistically retrying something we cannot classify would spend real
    // quota on a guess.
    const unknown = classifyAgentError(new Error("something exploded"));
    expect(unknown.code).toBe("unknown");
    expect(unknown.retryable).toBe(false);
  });

  it("keeps a provider-stated retry delay", () => {
    expect(classifyAgentError(Object.assign(new Error("429"), { retryAfter: 30 })).retryAfterMs)
      .toBe(30_000);
    expect(classifyAgentError(Object.assign(new Error("429"), { retryAfterMs: 1_500 })).retryAfterMs)
      .toBe(1_500);
    expect(classifyAgentError(Object.assign(new Error("429"), { retry_after: "5" })).retryAfterMs)
      .toBe(5_000);
  });

  it("records which provider failed", () => {
    expect(classifyAgentError(new Error("nope"), { provider: "codex" }).provider).toBe("codex");
  });

  it("handles a non-Error value without throwing", () => {
    expect(classifyAgentError("plain string").message).toBe("plain string");
    expect(classifyAgentError(undefined).code).toBe("unknown");
  });
});

describe("bounded retry policy", () => {
  const policy = boundedRetryPolicy({ maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 5_000 });

  it("stops after the attempt budget", () => {
    expect(policy.shouldRetry(error("rate_limited"), 1)).toBe(true);
    expect(policy.shouldRetry(error("rate_limited"), 2)).toBe(true);
    // Retrying forever would turn a provider outage into an endless quota burn.
    expect(policy.shouldRetry(error("rate_limited"), 3)).toBe(false);
  });

  it("refuses to retry what cannot be fixed by retrying", () => {
    for (const code of ["authentication_failed", "quota_exhausted", "cancelled", "unknown"] as const) {
      expect(policy.shouldRetry(error(code), 1)).toBe(false);
    }
  });

  it("honours a provider's stated delay over its own formula", () => {
    expect(policy.nextDelayMs(error("rate_limited", 2_000), 1)).toBe(2_000);
  });

  it("caps even a provider's delay so a run cannot stall indefinitely", () => {
    expect(policy.nextDelayMs(error("rate_limited", 10 * 60 * 1000), 1)).toBe(5_000);
  });

  it("backs off between attempts when no delay was given", () => {
    expect(policy.nextDelayMs(error("timeout"), 1)).toBe(100);
    expect(policy.nextDelayMs(error("timeout"), 2)).toBe(200);
    expect(policy.nextDelayMs(error("timeout"), 3)).toBe(400);
  });

  it("can be configured to disable retrying entirely", () => {
    const off = boundedRetryPolicy({ maxAttempts: 1 });
    expect(off.shouldRetry(error("rate_limited"), 1)).toBe(false);
  });
});
