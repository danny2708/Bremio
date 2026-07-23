/**
 * Normalized provider failures.
 *
 * Every provider reports trouble differently, so a caller that wants to decide
 * "is this worth retrying" would otherwise be matching strings against three
 * unrelated error formats. Classification happens once, here.
 *
 * This is deliberately a small foundation, not a retry engine: enough to make
 * a bounded, conservative decision and to show the user a specific reason.
 */

export type AgentErrorCode =
  | "rate_limited"
  | "authentication_failed"
  | "quota_exhausted"
  | "provider_unavailable"
  | "timeout"
  | "cancelled"
  | "session_not_found"
  | "execution_failed"
  | "unknown";

export interface AgentError {
  code: AgentErrorCode;
  message: string;
  /** Honoured verbatim when a provider states it; never invented. */
  retryAfterMs?: number;
  provider?: string;
  retryable: boolean;
}

/**
 * Codes worth another attempt.
 *
 * Authentication and quota exhaustion are excluded because retrying cannot fix
 * either — it just burns attempts and delays telling the user what is actually
 * wrong. Cancellation is excluded because the user asked for it.
 */
const RETRYABLE: ReadonlySet<AgentErrorCode> = new Set<AgentErrorCode>([
  "rate_limited",
  "provider_unavailable",
  "timeout",
]);

export function isRetryableCode(code: AgentErrorCode): boolean {
  return RETRYABLE.has(code);
}

const PATTERNS: ReadonlyArray<[RegExp, AgentErrorCode]> = [
  [/session.*not found|no rollout found|invalid session|not a uuid|unknown session|expired session/i, "session_not_found"],
  [/rate.?limit|429|too many requests|slow down/i, "rate_limited"],
  [/quota|usage limit|credit|billing|insufficient funds/i, "quota_exhausted"],
  [/unauthor|forbidden|401|403|invalid api key|not logged in|authentication/i, "authentication_failed"],
  [/timed? ?out|etimedout|deadline exceeded/i, "timeout"],
  [/abort|cancel/i, "cancelled"],
  [/econnrefused|enotfound|econnreset|socket hang up|unavailable|503|502/i, "provider_unavailable"],
];

/**
 * Classify a provider failure.
 *
 * Ordering matters: a quota message often also contains the word "limit", and
 * an auth failure often mentions a key, so the more specific patterns are
 * tested first. An unrecognized failure stays `unknown` and non-retryable
 * rather than being optimistically retried.
 */
export function classifyAgentError(
  error: unknown,
  options: { provider?: string; retryAfterMs?: number } = {},
): AgentError {
  const message = error instanceof Error ? error.message : String(error ?? "unknown error");
  const explicit = options.retryAfterMs ?? retryAfterFrom(error);

  let code: AgentErrorCode = "unknown";
  for (const [pattern, candidate] of PATTERNS) {
    if (pattern.test(message)) {
      code = candidate;
      break;
    }
  }

  return {
    code,
    message,
    retryable: isRetryableCode(code),
    ...(options.provider ? { provider: options.provider } : {}),
    ...(explicit !== undefined ? { retryAfterMs: explicit } : {}),
  };
}

/** Pull a provider-stated retry delay out of common shapes, in milliseconds. */
function retryAfterFrom(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const candidate = error as Record<string, unknown>;

  const direct = candidate.retryAfterMs ?? candidate.retry_after_ms;
  if (typeof direct === "number" && Number.isFinite(direct) && direct >= 0) return direct;

  // `Retry-After` is expressed in seconds by the HTTP spec.
  const seconds = candidate.retryAfter ?? candidate.retry_after;
  if (typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }
  if (typeof seconds === "string" && /^\d+$/.test(seconds)) return Number(seconds) * 1000;

  return undefined;
}

export interface RetryPolicy {
  shouldRetry(error: AgentError, attempt: number): boolean;
  nextDelayMs(error: AgentError, attempt: number): number;
}

export interface BoundedRetryOptions {
  /** Total attempts including the first; 1 disables retrying. */
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

/**
 * A deliberately conservative policy.
 *
 * No adaptive backoff and no learning from provider history: those need
 * evidence Bremio does not have yet, and a wrong guess costs real quota. This
 * only ensures a transient failure gets a small, bounded second chance, and
 * that a provider's own stated delay always wins over the computed one.
 */
export function boundedRetryPolicy(options: BoundedRetryOptions = {}): RetryPolicy {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
  const baseDelayMs = Math.max(0, options.baseDelayMs ?? 1_000);
  const maxDelayMs = Math.max(baseDelayMs, options.maxDelayMs ?? 30_000);

  return {
    shouldRetry(error, attempt) {
      if (!error.retryable) return false;
      return attempt < maxAttempts;
    },
    nextDelayMs(error, attempt) {
      // A provider that says when to come back knows better than any formula.
      if (error.retryAfterMs !== undefined) return Math.min(error.retryAfterMs, maxDelayMs);
      const exponential = baseDelayMs * 2 ** Math.max(0, attempt - 1);
      return Math.min(exponential, maxDelayMs);
    },
  };
}
