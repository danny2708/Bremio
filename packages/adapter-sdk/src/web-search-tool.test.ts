import { describe, it, expect, vi } from "vitest";
import {
  WebSearchTool,
  braveSearchBackend,
  jsonSearchBackend,
  resolveWebSearchBackend,
} from "./web-search-tool";

/** These tests are about backends and timeouts; the gate has its own below. */
const ALLOW = () => ({ allowed: true, reason: "test" });

function mockFetch(data: unknown, ok = true): typeof globalThis.fetch {
  return vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 500,
    statusText: ok ? "OK" : "Internal Server Error",
    json: () => Promise.resolve(data),
  }) as unknown as typeof globalThis.fetch;
}

function mockFetchDelayed(data: unknown, delay: number): typeof globalThis.fetch {
  return vi.fn().mockImplementation(
    (_, init?: RequestInit) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(
          () =>
            resolve({ ok: true, status: 200, statusText: "OK", json: () => Promise.resolve(data) } as Response),
          delay,
        );
        init?.signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(new DOMException("The operation was aborted", "AbortError"));
          },
          { once: true },
        );
      }),
  ) as unknown as typeof globalThis.fetch;
}

const JSON_BACKEND = jsonSearchBackend({ endpoint: "https://search.example.test/api" });
const jsonResponse = {
  results: [
    { title: "TypeScript", url: "https://www.typescriptlang.org/", snippet: "JavaScript with syntax for types." },
    { title: "Handbook", url: "https://www.typescriptlang.org/docs/", snippet: "The handbook." },
    { title: "No url", snippet: "dropped" },
  ],
};

describe("WebSearchTool (P3-T4)", () => {
  it("answers `unconfigured` without a backend and sends nothing", async () => {
    const fetchFn = mockFetch({});
    const tool = new WebSearchTool(ALLOW, undefined, fetchFn, "set BREMIO_WEB_SEARCH_BACKEND");
    const result = await tool.execute("anything");
    expect(result).toMatchObject({ status: "unconfigured", results: [], reason: "set BREMIO_WEB_SEARCH_BACKEND" });
    expect(tool.configured).toBe(false);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("returns ranked results from a JSON backend, dropping entries without a url", async () => {
    const fetchFn = mockFetch(jsonResponse);
    const result = await new WebSearchTool(ALLOW, JSON_BACKEND, fetchFn).execute("typescript");
    expect(result.status).toBe("ok");
    expect(result.backend).toBe("json");
    expect(result.results.map((r) => r.url)).toEqual([
      "https://www.typescriptlang.org/",
      "https://www.typescriptlang.org/docs/",
    ]);
    const url = new URL((fetchFn as unknown as { mock: { calls: [string][] } }).mock.calls[0]![0]);
    expect(url.searchParams.get("q")).toBe("typescript");
    expect(url.searchParams.get("count")).toBe("5");
  });

  it("limits results to maxResults", async () => {
    const result = await new WebSearchTool(ALLOW, JSON_BACKEND, mockFetch(jsonResponse)).execute("t", {
      maxResults: 1,
    });
    expect(result.results).toHaveLength(1);
  });

  it("sends the JSON backend key as a bearer token or a named header", async () => {
    const bearer = mockFetch({ results: [] });
    await new WebSearchTool(ALLOW, jsonSearchBackend({ endpoint: "https://s.test/", apiKey: "k1" }), bearer).execute("q");
    expect((bearer as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]![1].headers).toMatchObject({
      Authorization: "Bearer k1",
    });
    const named = mockFetch({ results: [] });
    await new WebSearchTool(
      ALLOW,
      jsonSearchBackend({ endpoint: "https://s.test/", apiKey: "k2", apiKeyHeader: "X-Api-Key" }),
      named,
    ).execute("q");
    expect((named as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]![1].headers).toMatchObject({
      "X-Api-Key": "k2",
    });
  });

  it("rejects a JSON backend answer without a results array", async () => {
    await expect(new WebSearchTool(ALLOW, JSON_BACKEND, mockFetch({ AbstractText: "x" })).execute("q")).rejects.toThrow(
      /returned no "results" array/,
    );
  });

  it("parses Brave's web.results and sends its subscription header", async () => {
    const fetchFn = mockFetch({
      web: { results: [{ title: "Node", url: "https://nodejs.org/", description: "Node.js runtime" }] },
    });
    const result = await new WebSearchTool(ALLOW, braveSearchBackend({ apiKey: "bk" }), fetchFn).execute("node");
    expect(result.results).toEqual([{ title: "Node", url: "https://nodejs.org/", snippet: "Node.js runtime" }]);
    const [url, init] = (fetchFn as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]!;
    expect(url.startsWith("https://api.search.brave.com/res/v1/web/search?")).toBe(true);
    expect(init.headers).toMatchObject({ "X-Subscription-Token": "bk" });
  });

  it("surfaces backend HTTP errors", async () => {
    await expect(new WebSearchTool(ALLOW, JSON_BACKEND, mockFetch({}, false)).execute("q")).rejects.toThrow(
      /search request failed: 500/,
    );
  });

  it("reports timed-out when the timeout is exceeded", async () => {
    const result = await new WebSearchTool(ALLOW, JSON_BACKEND, mockFetchDelayed(jsonResponse, 5000)).execute("q", {
      timeout: 50,
    });
    expect(result).toMatchObject({ status: "timed-out", timedOut: true, results: [] });
  });

  it("cancels via an external AbortSignal", async () => {
    const ac = new AbortController();
    const pending = new WebSearchTool(ALLOW, JSON_BACKEND, mockFetchDelayed(jsonResponse, 5000)).execute("q", {
      signal: ac.signal,
    });
    ac.abort();
    await expect(pending).rejects.toThrow();
  });

  describe("network permission gate", () => {
    it("does not reach the network when the query is denied", async () => {
      const fetchFn = mockFetch(jsonResponse);
      const tool = new WebSearchTool(() => ({ allowed: false, reason: "network denied in plan mode" }), JSON_BACKEND, fetchFn);
      await expect(tool.execute("secrets")).rejects.toThrow(/network denied in plan mode/);
      expect(fetchFn).not.toHaveBeenCalled();
    });

    it("asks about the actual query and the backend's endpoint", async () => {
      const check = vi.fn().mockReturnValue({ allowed: true, reason: "ok" });
      await new WebSearchTool(check, JSON_BACKEND, mockFetch({ results: [] })).execute("typescript");
      expect(check).toHaveBeenCalledWith("network", "typescript", "https://search.example.test/api");
    });

    it("still applies policy when unconfigured", async () => {
      const tool = new WebSearchTool(() => ({ allowed: false, reason: "plan mode" }));
      await expect(tool.execute("q")).rejects.toThrow(/web search denied: plan mode/);
    });
  });
});

describe("resolveWebSearchBackend (P3-T4)", () => {
  it("configures nothing by default", () => {
    expect(resolveWebSearchBackend({})).toEqual({ reason: expect.stringMatching(/no web search backend configured/) });
  });

  it("builds brave from a key in the default or a named variable", () => {
    const a = resolveWebSearchBackend({ BREMIO_WEB_SEARCH_BACKEND: "brave", BREMIO_WEB_SEARCH_API_KEY: "k" });
    expect("backend" in a && a.backend.id).toBe("brave");
    const b = resolveWebSearchBackend({
      BREMIO_WEB_SEARCH_BACKEND: "brave",
      BREMIO_WEB_SEARCH_API_KEY_ENV: "MY_BRAVE_KEY",
      MY_BRAVE_KEY: "k",
    });
    expect("backend" in b && b.backend.id).toBe("brave");
  });

  it("names what is missing", () => {
    expect(resolveWebSearchBackend({ BREMIO_WEB_SEARCH_BACKEND: "brave" })).toEqual({
      reason: 'web search backend "brave" needs an API key in BREMIO_WEB_SEARCH_API_KEY',
    });
    expect(resolveWebSearchBackend({ BREMIO_WEB_SEARCH_BACKEND: "json" })).toEqual({
      reason: 'web search backend "json" needs BREMIO_WEB_SEARCH_ENDPOINT',
    });
    expect(resolveWebSearchBackend({ BREMIO_WEB_SEARCH_BACKEND: "ddg" })).toEqual({
      reason: 'unknown web search backend "ddg" (supported: brave, json)',
    });
  });

  it("builds json from an endpoint", () => {
    const r = resolveWebSearchBackend({
      BREMIO_WEB_SEARCH_BACKEND: "json",
      BREMIO_WEB_SEARCH_ENDPOINT: "https://s.test/search",
    });
    expect("backend" in r && r.backend.endpoint).toBe("https://s.test/search");
  });
});
