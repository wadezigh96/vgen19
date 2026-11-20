import { describe, expect, it } from "vitest";

import type { FetchFn, FetchResponse } from "../src/llm/http.js";
import {
  FallbackSearchProvider,
  FakeSearchProvider,
  KeylessTavilySearchProvider,
  SearchError,
  TavilySearchProvider,
  type SearchProvider,
  type SearchResult,
} from "../src/search/index.js";

function stubResponse(
  body: unknown,
  status = 200,
): FetchResponse & { textBody: string } {
  const textBody =
    typeof body === "string" ? body : JSON.stringify(body);
  return {
    json: () => Promise.resolve(body as unknown),
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(textBody),
    textBody,
  };
}

/** A canned Tavily search response, in the documented wire shape. */
const TAVILY_BODY = {
  query: "Zanara election",
  response_time: 1.23,
  results: [
    {
      content: "The Zanara Election Commission announced a general election.",
      published_date: "Tue, 11 Mar 2025 17:00:00 GMT",
      score: 0.97,
      title: "Zanara election announced",
      url: "https://example.invalid/news/zanara-election",
    },
    {
      content: "Zanara opposition parties welcomed the announcement.",
      score: 0.81,
      title: "Opposition welcomes Zanara vote",
      url: "https://example.invalid/news/zanara-opposition",
    },
  ],
  usage: { credits: 1 },
};

describe("TavilySearchProvider", () => {
  it("posts to the Tavily search endpoint with Bearer auth and basic depth", async () => {
    const seen: Array<{ init: Parameters<FetchFn>[1]; url: string }> = [];
    const fetchFn: FetchFn = (url, init) => {
      seen.push({ init, url });
      return Promise.resolve(stubResponse(TAVILY_BODY));
    };
    const provider = new TavilySearchProvider({
      apiKey: "tvly-test-key",
      fetchFn,
    });

    await provider.search("Zanara election", { maxResults: 5 });

    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("https://api.tavily.com/search");
    expect(seen[0]!.init.method).toBe("POST");
    expect(seen[0]!.init.headers["Authorization"]).toBe(
      "Bearer tvly-test-key",
    );
    expect(seen[0]!.init.headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(seen[0]!.init.body) as Record<string, unknown>;
    expect(body["query"]).toBe("Zanara election");
    // Basic depth costs 1 credit; advanced costs 2. The provider must
    // never pay for advanced depth by accident.
    expect(body["search_depth"]).toBe("basic");
    expect(body["max_results"]).toBe(5);
    // The api_key body field is the legacy auth form; it must not appear.
    expect(body["api_key"]).toBeUndefined();
    expect(seen[0]!.init.headers["X-Api-Key"]).toBeUndefined();
  });

  it("maps content to snippet and published_date to publishedDate", async () => {
    const fetchFn: FetchFn = () =>
      Promise.resolve(stubResponse(TAVILY_BODY));
    const provider = new TavilySearchProvider({
      apiKey: "tvly-test-key",
      fetchFn,
    });

    const { results } = await provider.search("Zanara election");

    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      publishedDate: "Tue, 11 Mar 2025 17:00:00 GMT",
      snippet:
        "The Zanara Election Commission announced a general election.",
      title: "Zanara election announced",
      url: "https://example.invalid/news/zanara-election",
    });
    // A result without a published date carries none, rather than a
    // made-up one.
    expect(results[1]!.publishedDate).toBeUndefined();
  });

  it("uses a configurable endpoint instead of the default", async () => {
    const seen: string[] = [];
    const fetchFn: FetchFn = (url) => {
      seen.push(url);
      return Promise.resolve(stubResponse(TAVILY_BODY));
    };
    const provider = new TavilySearchProvider({
      apiKey: "tvly-test-key",
      endpoint: "https://search.example.invalid/search",
      fetchFn,
    });

    await provider.search("Zanara election");

    expect(seen).toEqual(["https://search.example.invalid/search"]);
  });

  it("throws SearchError on a non-2xx status without leaking the key", async () => {
    const fetchFn: FetchFn = () =>
      Promise.resolve(stubResponse({ detail: "bad key" }, 401));
    const provider = new TavilySearchProvider({
      apiKey: "tvly-test-key",
      fetchFn,
    });

    const error = await provider
      .search("Zanara election")
      .then(
        () => null,
        (caught: unknown) => caught,
      );
    expect(error).toBeInstanceOf(SearchError);
    expect((error as Error).message).toContain("401");
    expect((error as Error).message).not.toContain("tvly-test-key");
  });

  it("throws SearchError on a network failure", async () => {
    const fetchFn: FetchFn = () =>
      Promise.reject(new Error("connection reset"));
    const provider = new TavilySearchProvider({
      apiKey: "tvly-test-key",
      fetchFn,
    });

    await expect(provider.search("Zanara election")).rejects.toBeInstanceOf(
      SearchError,
    );
  });

  it("sends an abort signal so a hung search times out", async () => {
    const seen: Array<{ init: Parameters<FetchFn>[1] }> = [];
    const fetchFn: FetchFn = (_url, init) => {
      seen.push({ init });
      return Promise.resolve(stubResponse(TAVILY_BODY));
    };
    const provider = new TavilySearchProvider({
      apiKey: "tvly-test-key",
      fetchFn,
    });

    await provider.search("Zanara election");

    expect(seen[0]!.init.signal).toBeInstanceOf(AbortSignal);
    expect(seen[0]!.init.signal!.aborted).toBe(false);
  });

  it("fails with a SearchError when the search times out", async () => {
    const fetchFn: FetchFn = (_url, init) =>
      new Promise<FetchResponse>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          reject(new Error("The operation was aborted"));
        });
      });
    const provider = new TavilySearchProvider({
      apiKey: "tvly-test-key",
      fetchFn,
      timeoutMs: 10,
    });

    await expect(provider.search("Zanara election")).rejects.toBeInstanceOf(
      SearchError,
    );
  });

  it("turns invalid JSON in a 200 reply into a SearchError, not a raw SyntaxError", async () => {
    const fetchFn: FetchFn = () =>
      Promise.resolve({
        json: async (): Promise<unknown> => {
          throw new SyntaxError("Unexpected token < in JSON");
        },
        ok: true,
        status: 200,
        text: async () => "<html>not json</html>",
      });
    const provider = new TavilySearchProvider({
      apiKey: "tvly-test-key",
      fetchFn,
    });

    const error = await provider.search("Zanara election").then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(SearchError);
    expect(error).not.toBeInstanceOf(SyntaxError);
  });

  it("skips a null or non-object element in the results list instead of crashing", async () => {
    const fetchFn: FetchFn = () =>
      Promise.resolve(
        stubResponse({
          results: [
            null,
            "not an object",
            TAVILY_BODY.results[0],
            { title: "No URL here" },
          ],
          usage: { credits: 1 },
        }),
      );
    const provider = new TavilySearchProvider({
      apiKey: "tvly-test-key",
      fetchFn,
    });

    const { results } = await provider.search("Zanara election");

    expect(results).toHaveLength(1);
    expect(results[0]!.title).toBe("Zanara election announced");
  });

  it("surfaces Tavily usage credits in the response", async () => {
    const fetchFn: FetchFn = () =>
      Promise.resolve(stubResponse(TAVILY_BODY));
    const provider = new TavilySearchProvider({
      apiKey: "tvly-test-key",
      fetchFn,
    });

    const response = await provider.search("Zanara election");

    expect(response.usage).toEqual({ credits: 1 });
  });

  it("omits usage when the response carries no usable credit count", async () => {
    const fetchFn: FetchFn = () =>
      Promise.resolve(
        stubResponse({ results: TAVILY_BODY.results, usage: { credits: "1" } }),
      );
    const provider = new TavilySearchProvider({
      apiKey: "tvly-test-key",
      fetchFn,
    });

    const response = await provider.search("Zanara election");

    expect(response.usage).toBeUndefined();
  });
});

describe("KeylessTavilySearchProvider", () => {
  it("searches without a key, using the keyless access header", async () => {
    const seen: Array<{ init: Parameters<FetchFn>[1]; url: string }> = [];
    const fetchFn: FetchFn = (url, init) => {
      seen.push({ init, url });
      return Promise.resolve(stubResponse(TAVILY_BODY));
    };
    const provider = new KeylessTavilySearchProvider({ fetchFn });

    const { results } = await provider.search("Zanara election");

    expect(results).toHaveLength(2);
    expect(seen[0]!.url).toBe("https://api.tavily.com/search");
    expect(seen[0]!.init.headers["X-Tavily-Access-Mode"]).toBe("keyless");
    expect(seen[0]!.init.headers["Authorization"]).toBeUndefined();
  });
});

describe("FallbackSearchProvider", () => {
  const canned: SearchResult[] = [
    {
      snippet: "A sourced snippet.",
      title: "A title",
      url: "https://example.invalid/a",
    },
  ];

  it("uses the primary provider when it succeeds", async () => {
    const primary = new FakeSearchProvider({ results: canned });
    const fallback = new FakeSearchProvider({ results: [] });
    const provider = new FallbackSearchProvider({ fallback, primary });

    const { results } = await provider.search("Zanara election");

    expect(results).toEqual(canned);
    expect(primary.queries).toEqual(["Zanara election"]);
    expect(fallback.queries).toEqual([]);
  });

  it("falls back to the keyless provider when Tavily fails", async () => {
    const primary = new FakeSearchProvider({
      results: [],
      script: [{ error: new SearchError("Tavily is down") }],
    });
    const fallback = new FakeSearchProvider({ results: canned });
    const provider = new FallbackSearchProvider({ fallback, primary });

    const { results } = await provider.search("Zanara election");

    expect(results).toEqual(canned);
    expect(primary.queries).toEqual(["Zanara election"]);
    expect(fallback.queries).toEqual(["Zanara election"]);
  });

  it("fails closed naming both providers when both fail", async () => {
    const primary = new FakeSearchProvider({
      results: [],
      script: [{ error: new SearchError("Tavily is down") }],
    });
    const fallback = new FakeSearchProvider({
      results: [],
      script: [{ error: new SearchError("keyless limit reached") }],
    });
    const provider = new FallbackSearchProvider({ fallback, primary });

    await expect(provider.search("Zanara election")).rejects.toThrow(
      /tavily.*keyless/i,
    );
  });
});

describe("FakeSearchProvider", () => {
  it("returns scripted results per query and records every query", async () => {
    const provider = new FakeSearchProvider({
      resultsByQuery: {
        "Zanara election": [
          {
            snippet: "Election announced.",
            title: "Election",
            url: "https://example.invalid/election",
          },
        ],
      },
    });

    const first = await provider.search("Zanara election");
    const second = await provider.search("something else");

    expect(first.results).toHaveLength(1);
    expect(second.results).toEqual([]);
    expect(provider.queries).toEqual(["Zanara election", "something else"]);
  });

  it("plays scripted errors in order", async () => {
    const provider = new FakeSearchProvider({
      results: [],
      script: [
        { error: new SearchError("boom") },
        {
          results: [
            {
              snippet: "Recovered.",
              title: "Recovered",
              url: "https://example.invalid/recovered",
            },
          ],
        },
      ],
    });

    await expect(provider.search("q")).rejects.toThrow("boom");
    const { results } = await provider.search("q");
    expect(results).toHaveLength(1);
  });

  it("satisfies the SearchProvider interface", () => {
    const provider: SearchProvider = new FakeSearchProvider();
    expect(typeof provider.search).toBe("function");
  });

  it("reports one usage credit per search, like a basic Tavily search", async () => {
    const provider = new FakeSearchProvider({ results: [] });

    const response = await provider.search("q");

    expect(response.usage).toEqual({ credits: 1 });
  });
});
