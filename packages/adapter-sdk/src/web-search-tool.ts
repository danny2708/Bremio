export interface WebSearchResultItem {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchToolOptions {
  maxResults?: number;
  signal?: AbortSignal;
  timeout?: number;
}

export interface WebSearchResult {
  /**
   * - `ok`: the backend answered (possibly with zero results).
   * - `timed-out`: the timeout elapsed first.
   * - `unconfigured`: no backend is configured; nothing left the machine.
   */
  status: "ok" | "timed-out" | "unconfigured";
  results: WebSearchResultItem[];
  duration: number;
  timedOut: boolean;
  /** Which backend answered, or why none could. */
  backend?: string;
  reason?: string;
}

/** The policy answer for one search, from the caller's `ControlMode` matrix. */
export interface WebSearchPermissionCheck {
  allowed: boolean;
  reason: string;
}

/**
 * A search provider (docs/17 P3-T4). Pluggable so Bremio is not tied to one
 * vendor, and so "no backend" can be an honest state instead of a default
 * that quietly returns something that is not search results.
 */
export interface WebSearchBackend {
  /** Short id for events and errors, e.g. "brave" or "json". */
  readonly id: string;
  /** Where queries go; shown to the permission check. */
  readonly endpoint: string;
  search(
    query: string,
    options: { maxResults: number; signal: AbortSignal; fetchFn: typeof globalThis.fetch },
  ): Promise<WebSearchResultItem[]>;
}

async function getJson(
  fetchFn: typeof globalThis.fetch,
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<unknown> {
  const response = await fetchFn(url, { signal, headers: { Accept: "application/json", ...headers } });
  if (!response.ok) {
    throw new Error(`search request failed: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

const asString = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * Generic JSON search API: `GET <endpoint>?q=<query>&count=<n>` answering
 * `{ "results": [{ "title", "url", "snippet" }] }`. Fits a self-hosted
 * search proxy (e.g. a SearXNG/Tavily shim) without a vendor-specific parser.
 */
export function jsonSearchBackend(opts: {
  endpoint: string;
  apiKey?: string;
  /** Header that carries the key; default `Authorization: Bearer <key>`. */
  apiKeyHeader?: string;
}): WebSearchBackend {
  return {
    id: "json",
    endpoint: opts.endpoint,
    async search(query, { maxResults, signal, fetchFn }) {
      const url = new URL(opts.endpoint);
      url.searchParams.set("q", query);
      url.searchParams.set("count", String(maxResults));
      const headers: Record<string, string> = {};
      if (opts.apiKey) {
        if (opts.apiKeyHeader) headers[opts.apiKeyHeader] = opts.apiKey;
        else headers.Authorization = `Bearer ${opts.apiKey}`;
      }
      const data = (await getJson(fetchFn, url.toString(), headers, signal)) as { results?: unknown };
      if (!Array.isArray(data?.results)) {
        throw new Error('search backend "json" returned no "results" array');
      }
      return data.results
        .map((r) => r as Record<string, unknown>)
        .map((r) => ({ title: asString(r.title), url: asString(r.url), snippet: asString(r.snippet) }))
        .filter((r) => r.url)
        .slice(0, maxResults);
    },
  };
}

/** Brave Search API (`X-Subscription-Token`; results under `web.results`). */
export function braveSearchBackend(opts: { apiKey: string; endpoint?: string }): WebSearchBackend {
  const endpoint = opts.endpoint ?? "https://api.search.brave.com/res/v1/web/search";
  return {
    id: "brave",
    endpoint,
    async search(query, { maxResults, signal, fetchFn }) {
      const url = new URL(endpoint);
      url.searchParams.set("q", query);
      url.searchParams.set("count", String(maxResults));
      const data = (await getJson(fetchFn, url.toString(), { "X-Subscription-Token": opts.apiKey }, signal)) as {
        web?: { results?: unknown };
      };
      const results = Array.isArray(data?.web?.results) ? data.web.results : [];
      return results
        .map((r) => r as Record<string, unknown>)
        .map((r) => ({ title: asString(r.title), url: asString(r.url), snippet: asString(r.description) }))
        .filter((r) => r.url)
        .slice(0, maxResults);
    },
  };
}

/**
 * Pick a backend from the environment. Keys are read by *name*
 * (`BREMIO_WEB_SEARCH_API_KEY` unless `BREMIO_WEB_SEARCH_API_KEY_ENV` names
 * another variable) so Bremio never stores a search credential itself.
 *
 * Returns `{ reason }` when nothing usable is configured — never a default
 * backend the user did not choose.
 */
export function resolveWebSearchBackend(
  env: Record<string, string | undefined> = process.env,
): { backend: WebSearchBackend } | { reason: string } {
  const kind = env.BREMIO_WEB_SEARCH_BACKEND?.trim();
  if (!kind) {
    return { reason: "no web search backend configured (set BREMIO_WEB_SEARCH_BACKEND to brave or json)" };
  }
  const keyVar = env.BREMIO_WEB_SEARCH_API_KEY_ENV?.trim() || "BREMIO_WEB_SEARCH_API_KEY";
  const apiKey = env[keyVar]?.trim() || undefined;
  const endpoint = env.BREMIO_WEB_SEARCH_ENDPOINT?.trim() || undefined;
  if (kind === "brave") {
    if (!apiKey) return { reason: `web search backend "brave" needs an API key in ${keyVar}` };
    return { backend: braveSearchBackend({ apiKey, ...(endpoint ? { endpoint } : {}) }) };
  }
  if (kind === "json") {
    if (!endpoint) return { reason: 'web search backend "json" needs BREMIO_WEB_SEARCH_ENDPOINT' };
    const apiKeyHeader = env.BREMIO_WEB_SEARCH_API_KEY_HEADER?.trim() || undefined;
    return {
      backend: jsonSearchBackend({
        endpoint,
        ...(apiKey ? { apiKey } : {}),
        ...(apiKeyHeader ? { apiKeyHeader } : {}),
      }),
    };
  }
  return { reason: `unknown web search backend "${kind}" (supported: brave, json)` };
}

/**
 * Queries a search backend over the network.
 *
 * `checkPermission` is required and consulted before the request leaves the
 * machine: the query text can carry repository contents to a third party,
 * which is exactly the egress the `network` action class gates.
 *
 * Without a backend the tool answers `unconfigured` and sends nothing. It
 * used to default to DuckDuckGo's Instant Answer API, which returns topic
 * abstracts rather than search results — a default that looked like search
 * and was not (docs/17 §2.1 axis H).
 */
export class WebSearchTool {
  constructor(
    private readonly checkPermission: (
      actionClass: "network",
      query: string,
      endpoint: string,
    ) => WebSearchPermissionCheck,
    private readonly backend?: WebSearchBackend,
    private readonly fetchFn: typeof globalThis.fetch = fetch,
    private readonly unconfiguredReason = "no web search backend configured",
  ) {}

  /** Whether a backend is configured; `execute` answers `unconfigured` otherwise. */
  get configured(): boolean {
    return this.backend !== undefined;
  }

  async execute(query: string, options: WebSearchToolOptions = {}): Promise<WebSearchResult> {
    const started = Date.now();
    const { timeout, signal: externalSignal, maxResults = 5 } = options;

    // Before anything else: a denied search must never leave, and policy is
    // the more useful answer than "unconfigured" when both apply.
    const permission = this.checkPermission("network", query, this.backend?.endpoint ?? "(unconfigured)");
    if (!permission.allowed) {
      throw new Error(`web search denied: ${permission.reason}`);
    }

    if (!this.backend) {
      return {
        status: "unconfigured",
        results: [],
        duration: Date.now() - started,
        timedOut: false,
        reason: this.unconfiguredReason,
      };
    }

    const abortController = new AbortController();
    const signals: AbortSignal[] = [abortController.signal];
    if (externalSignal) signals.push(externalSignal);
    const combinedSignal = AbortSignal.any(signals);

    let timedOut = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    if (timeout !== undefined && timeout > 0) {
      timeoutId = setTimeout(() => {
        timedOut = true;
        abortController.abort(new Error(`timed out after ${timeout}ms`));
      }, timeout);
    }

    try {
      const results = await this.backend.search(query, {
        maxResults,
        signal: combinedSignal,
        fetchFn: this.fetchFn,
      });
      return {
        status: "ok",
        results,
        duration: Date.now() - started,
        timedOut,
        backend: this.backend.id,
      };
    } catch (err) {
      if (timedOut) {
        return {
          status: "timed-out",
          results: [],
          duration: Date.now() - started,
          timedOut: true,
          backend: this.backend.id,
        };
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
