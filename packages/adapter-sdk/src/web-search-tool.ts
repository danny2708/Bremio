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
  results: WebSearchResultItem[];
  duration: number;
  timedOut: boolean;
}

interface DuckDuckGoRelatedTopic {
  Text: string;
  FirstURL: string;
  Result?: string;
}

interface DuckDuckGoTopicCategory {
  Name: string;
  Topics: DuckDuckGoRelatedTopic[];
}

type DuckDuckGoTopic = DuckDuckGoRelatedTopic | DuckDuckGoTopicCategory;

interface DuckDuckGoResponse {
  AbstractText?: string;
  AbstractSource?: string;
  AbstractURL?: string;
  Heading?: string;
  Answer?: string;
  AnswerType?: string;
  Results?: DuckDuckGoRelatedTopic[];
  RelatedTopics?: DuckDuckGoTopic[];
  Type?: string;
}

export class WebSearchTool {
  constructor(
    private readonly fetchFn: typeof globalThis.fetch = fetch,
    private readonly endpoint = "https://api.duckduckgo.com/",
  ) {}

  async execute(
    query: string,
    options: WebSearchToolOptions = {},
  ): Promise<WebSearchResult> {
    const started = Date.now();
    const { timeout, signal: externalSignal, maxResults = 5 } = options;

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
      const params = new URLSearchParams({
        q: query,
        format: "json",
        no_html: "1",
        skip_disambig: "1",
      });
      const url = `${this.endpoint}?${params}`;
      const response = await this.fetchFn(url, {
        signal: combinedSignal,
        headers: { Accept: "application/json" },
      });
      if (!response.ok) {
        throw new Error(`search request failed: ${response.status} ${response.statusText}`);
      }
      const data = (await response.json()) as DuckDuckGoResponse;
      const results = this.parseResponse(data, maxResults);
      const duration = Date.now() - started;
      return { results, duration, timedOut };
    } catch (err) {
      if (timedOut) {
        const duration = Date.now() - started;
        return { results: [], duration, timedOut: true };
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private parseResponse(
    data: DuckDuckGoResponse,
    maxResults: number,
  ): WebSearchResultItem[] {
    const items: WebSearchResultItem[] = [];

    if (data.AbstractText && data.AbstractURL) {
      items.push({
        title: data.Heading || data.AbstractSource || "Summary",
        url: data.AbstractURL,
        snippet: data.AbstractText,
      });
    }

    if (data.Results) {
      for (const r of data.Results) {
        if (items.length >= maxResults) break;
        items.push(this.topicToItem(r));
      }
    }

    if (data.RelatedTopics) {
      for (const t of data.RelatedTopics) {
        if (items.length >= maxResults) break;
        if ("Topics" in t) {
          for (const sub of t.Topics) {
            if (items.length >= maxResults) break;
            items.push(this.topicToItem(sub));
          }
        } else {
          items.push(this.topicToItem(t));
        }
      }
    }

    return items.slice(0, maxResults);
  }

  private topicToItem(t: DuckDuckGoRelatedTopic): WebSearchResultItem {
    const snippet = t.Result
      ? t.Result.replace(/<[^>]+>/g, "").trim()
      : t.Text;
    return {
      title: t.Text.split(" - ")[0] || t.Text,
      url: t.FirstURL,
      snippet,
    };
  }
}
