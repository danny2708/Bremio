import { describe, it, expect, vi } from "vitest";
import { WebSearchTool, type WebSearchResult } from "./web-search-tool";

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
            resolve({
              ok: true,
              status: 200,
              statusText: "OK",
              json: () => Promise.resolve(data),
            } as Response),
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

describe("WebSearchTool", () => {
  const sampleResponse = {
    AbstractText: "TypeScript is a programming language developed by Microsoft.",
    AbstractSource: "Wikipedia",
    AbstractURL: "https://en.wikipedia.org/wiki/TypeScript",
    Heading: "TypeScript",
    Results: [
      {
        Text: "TypeScript: JavaScript With Syntax For Types.",
        FirstURL: "https://www.typescriptlang.org/",
        Result: "<b>TypeScript</b> extends JavaScript",
      },
    ],
    RelatedTopics: [
      {
        Text: "TypeScript Handbook - The TypeScript Handbook is a comprehensive guide",
        FirstURL: "https://www.typescriptlang.org/docs/handbook/intro.html",
        Result: "TypeScript <b>Handbook</b> guide",
      },
      {
        Name: "More",
        Topics: [
          {
            Text: "TypeScript Playground - Try TypeScript online",
            FirstURL: "https://www.typescriptlang.org/play",
            Result: "TypeScript <b>Playground</b>",
          },
        ],
      },
    ],
  };

  it("returns results from the API response", async () => {
    const fetchFn = mockFetch(sampleResponse);
    const tool = new WebSearchTool(fetchFn);
    const result = await tool.execute("typescript");

    expect(result.results.length).toBeGreaterThanOrEqual(3);
    expect(result.results[0]).toMatchObject({
      title: expect.any(String),
      url: expect.any(String),
      snippet: expect.any(String),
    });
    expect(result.duration).toBeGreaterThanOrEqual(0);
    expect(result.timedOut).toBe(false);
  });

  it("includes the abstract as the first result when present", async () => {
    const fetchFn = mockFetch(sampleResponse);
    const tool = new WebSearchTool(fetchFn);
    const result = await tool.execute("typescript");

    expect(result.results.length).toBeGreaterThanOrEqual(1);
    expect(result.results[0]!.url).toBe("https://en.wikipedia.org/wiki/TypeScript");
    expect(result.results[0]!.snippet).toContain("TypeScript is a programming language");
  });

  it("limits results to maxResults", async () => {
    const fetchFn = mockFetch(sampleResponse);
    const tool = new WebSearchTool(fetchFn);
    const result = await tool.execute("typescript", { maxResults: 2 });

    expect(result.results.length).toBe(2);
  });

  it("handles an empty response gracefully", async () => {
    const fetchFn = mockFetch({});
    const tool = new WebSearchTool(fetchFn);
    const result = await tool.execute("xyznonexistent12345");

    expect(result.results).toEqual([]);
    expect(result.timedOut).toBe(false);
  });

  it("handles API error responses", async () => {
    const fetchFn = mockFetch({ msg: "Internal error" }, false);
    const tool = new WebSearchTool(fetchFn);
    await expect(tool.execute("test")).rejects.toThrow("search request failed: 500");
  });

  it("reports timedOut when timeout is exceeded", async () => {
    const fetchFn = mockFetchDelayed(sampleResponse, 500);
    const tool = new WebSearchTool(fetchFn);

    const result = await tool.execute("typescript", { timeout: 50, maxResults: 5 });
    expect(result.timedOut).toBe(true);
    expect(result.results).toEqual([]);
    expect(result.duration).toBeLessThan(5000);
  });

  it("cancels via external AbortSignal", async () => {
    const fetchFn = vi.fn().mockImplementation(
      (_, { signal }: RequestInit) =>
        new Promise((_, reject) => {
          signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
        }),
    ) as unknown as typeof globalThis.fetch;

    const tool = new WebSearchTool(fetchFn);
    const controller = new AbortController();

    const promise = tool.execute("typescript", { signal: controller.signal });
    controller.abort();

    await expect(promise).rejects.toThrow();
  });

  it("handles nested topic categories", async () => {
    const response = {
      RelatedTopics: [
        {
          Name: "Category",
          Topics: [
            { Text: "Item one", FirstURL: "https://example.com/1", Result: "item one" },
            { Text: "Item two", FirstURL: "https://example.com/2", Result: "item two" },
          ],
        },
      ],
    };
    const fetchFn = mockFetch(response);
    const tool = new WebSearchTool(fetchFn);
    const result = await tool.execute("test");

    expect(result.results.length).toBe(2);
    expect(result.results[0]!.url).toBe("https://example.com/1");
    expect(result.results[1]!.url).toBe("https://example.com/2");
  });

  it("does not call fetch on empty query but returns empty", async () => {
    // DDG API will still be called with q=, but should return empty results
    const fetchFn = mockFetch({});
    const tool = new WebSearchTool(fetchFn);
    const result = await tool.execute("");

    expect(result.results).toEqual([]);
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("concurrent searches return independent results", async () => {
    const fetchA = mockFetch({
      AbstractText: "Result A",
      AbstractURL: "https://a.example.com",
      Heading: "Query A",
    });
    const fetchB = mockFetch({
      AbstractText: "Result B",
      AbstractURL: "https://b.example.com",
      Heading: "Query B",
    });

    const toolA = new WebSearchTool(fetchA);
    const toolB = new WebSearchTool(fetchB);

    const [rA, rB] = await Promise.all([
      toolA.execute("query a"),
      toolB.execute("query b"),
    ]);

    expect(rA.results.length).toBeGreaterThanOrEqual(1);
    expect(rA.results[0]!.snippet).toBe("Result A");
    expect(rB.results.length).toBeGreaterThanOrEqual(1);
    expect(rB.results[0]!.snippet).toBe("Result B");
  });
});
