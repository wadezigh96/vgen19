/**
 * Tavily search providers: the keyed default and the keyless fallback.
 *
 * Facts verified 20 November 2026 against docs.tavily.com and multiple
 * 2026 sources (coordinator verification; see README for the list):
 *
 * - Endpoint: POST https://api.tavily.com/search (unanimous across
 *   sources). Configurable via `TAVILY_SEARCH_ENDPOINT`; the verified
 *   URL below is the default, never a guessed value.
 * - Auth: `Authorization: Bearer <key>` header. The `api_key` field in
 *   the JSON body is the legacy form and is NOT used; the `X-Api-Key`
 *   header is wrong. Keys start with `tvly-` and come from
 *   app.tavily.com (env var `TAVILY_API_KEY`).
 * - Free tier: the Researcher plan, 1,000 API credits a month, no
 *   credit card, resetting on the 1st of the month.
 * - Cost: `search_depth` basic, fast, or ultra-fast costs 1 credit per
 *   search; advanced costs 2. This provider always sends `basic`
 *   explicitly, so Tavily's automatic parameter selection can never
 *   silently upgrade a search to the 2-credit depth.
 * - Request: `{ query, search_depth, max_results }`. `max_results`
 *   runs 0-20 and defaults to 5.
 * - Response: `{ results: [{ title, url, content, score,
 *   published_date }], usage: { credits }, response_time }`. `content`
 *   maps to the snippet; `published_date` (e.g. "Tue, 11 Mar 2025
 *   17:00:00 GMT") maps to the result date. `published_date` is only
 *   present for news-topic results, so it is often absent.
 * - Keyless mode: the same endpoint accepts `X-Tavily-Access-Mode:
 *   keyless` with no key at all, free and rate-limited (covers
 *   `/search` and `/extract` only). One live test in October 2026 hit
 *   a 429 (`hourly_cap_reached`) after about 30 calls from one IP, so
 *   the keyless fallback is a degraded mode, not a second quota.
 *   Sources: troiana.net Tavily guide, twitterapi.io Tavily guide,
 *   cors.dev free search API comparison (all checked November 2026).
 *
 * No other keyless option was used: DuckDuckGo's HTML endpoint
 * (html.duckduckgo.com) is an unofficial scraping surface with
 * bot-blocking that changed in February 2026 (searxng commit
 * 2e6eeb1d), so it is not a clean fallback. The Tavily keyless mode
 * above is the keyless fallback instead.
 */

import {
  DEFAULT_SEARCH_TIMEOUT_MS,
  defaultFetch,
  type FetchFn,
} from "../llm/http.js";
import { errorMessage } from "../util.js";
import type {
  SearchOptions,
  SearchProvider,
  SearchResponse,
  SearchResult,
} from "./types.js";
import { SearchError } from "./types.js";

/**
 * Verified Tavily search endpoint (see the header note). Overridable
 * per provider instance and via `TAVILY_SEARCH_ENDPOINT`.
 */
export const DEFAULT_TAVILY_SEARCH_ENDPOINT = "https://api.tavily.com/search";

/** Tavily search depth. Only `basic` is ever sent: 1 credit a search. */
const SEARCH_DEPTH = "basic";

interface TavilyRawResult {
  title?: unknown;
  url?: unknown;
  content?: unknown;
  published_date?: unknown;
}

/** Map one raw Tavily result onto the shared result shape. Null and non-object elements are skipped, never dereferenced. */
function mapResult(raw: unknown): SearchResult | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return null;
  }
  const candidate = raw as TavilyRawResult;
  if (
    typeof candidate.title !== "string" ||
    typeof candidate.url !== "string" ||
    typeof candidate.content !== "string"
  ) {
    return null;
  }
  const publishedDate =
    typeof candidate.published_date === "string" &&
    candidate.published_date.trim() !== ""
      ? candidate.published_date
      : undefined;
  return {
    snippet: candidate.content,
    title: candidate.title,
    url: candidate.url,
    ...(publishedDate !== undefined ? { publishedDate } : {}),
  };
}

/** The credits Tavily reports for a search, when the reply carries a usable count. */
function usageCredits(data: { usage?: unknown }): number | undefined {
  const usage = data.usage;
  if (typeof usage !== "object" || usage === null) {
    return undefined;
  }
  const credits = (usage as { credits?: unknown }).credits;
  if (typeof credits !== "number" || !Number.isFinite(credits) || credits < 0) {
    return undefined;
  }
  return credits;
}

async function postSearch(
  endpoint: string,
  headers: Record<string, string>,
  query: string,
  options: SearchOptions | undefined,
  fetchFn: FetchFn,
  providerName: string,
  timeoutMs: number,
): Promise<SearchResponse> {
  const maxResults = options?.maxResults;
  let response;
  try {
    response = await fetchFn(endpoint, {
      body: JSON.stringify({
        query,
        search_depth: SEARCH_DEPTH,
        ...(maxResults !== undefined ? { max_results: maxResults } : {}),
      }),
      headers: {
        "Content-Type": "application/json",
        ...headers,
      },
      method: "POST",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new SearchError(
      `${providerName} search failed: ${errorMessage(error)}`,
    );
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new SearchError(
      `${providerName} search failed with status ${response.status}` +
        (detail === "" ? "." : `: ${detail.slice(0, 300)}`),
    );
  }

  let data: { results?: unknown; usage?: unknown };
  try {
    data = (await response.json()) as { results?: unknown; usage?: unknown };
  } catch (error) {
    throw new SearchError(
      `${providerName} search returned invalid JSON: ${errorMessage(error)}`,
    );
  }
  if (!Array.isArray(data.results)) {
    throw new SearchError(
      `${providerName} search returned a response without a results list.`,
    );
  }
  const results = (data.results as unknown[])
    .map(mapResult)
    .filter((result): result is SearchResult => result !== null);
  const credits = usageCredits(data);
  return {
    results,
    ...(credits !== undefined ? { usage: { credits } } : {}),
  };
}

export interface TavilySearchProviderOptions {
  /** Tavily API key (`tvly-...`). Never logged or put in errors. */
  apiKey: string;
  /** Search endpoint. Defaults to `DEFAULT_TAVILY_SEARCH_ENDPOINT`. */
  endpoint?: string;
  /** Injectable fetch; defaults to the global fetch. Tests stub this. */
  fetchFn?: FetchFn;
  /** Per-search timeout in milliseconds. Defaults to 30 seconds. */
  timeoutMs?: number;
}

/**
 * The default search provider: Tavily free tier (Researcher plan,
 * 1,000 credits a month). Authenticates with a Bearer <redacted> always
 * basic depth (1 credit a search).
 */
export class TavilySearchProvider implements SearchProvider {
  readonly name = "tavily";

  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly fetchFn: FetchFn;
  private readonly timeoutMs: number;

  constructor(options: TavilySearchProviderOptions) {
    this.apiKey = options.apiKey;
    this.endpoint = options.endpoint ?? DEFAULT_TAVILY_SEARCH_ENDPOINT;
    this.fetchFn = options.fetchFn ?? defaultFetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS;
  }

  async search(
    query: string,
    options?: SearchOptions,
  ): Promise<SearchResponse> {
    return postSearch(
      this.endpoint,
      { Authorization: `Bearer ${this.apiKey}` },
      query,
      options,
      this.fetchFn,
      "Tavily",
      this.timeoutMs,
    );
  }
}

export interface KeylessTavilySearchProviderOptions {
  /** Search endpoint. Defaults to `DEFAULT_TAVILY_SEARCH_ENDPOINT`. */
  endpoint?: string;
  /** Injectable fetch; defaults to the global fetch. Tests stub this. */
  fetchFn?: FetchFn;
  /** Per-search timeout in milliseconds. Defaults to 30 seconds. */
  timeoutMs?: number;
}

/**
 * The keyless fallback search provider: Tavily's keyless mode on the
 * same endpoint, with the `X-Tavily-Access-Mode: keyless` header and
 * no key. Free and rate-limited; a degraded mode for when the keyed
 * provider is unavailable or no key is configured.
 */
export class KeylessTavilySearchProvider implements SearchProvider {
  readonly name = "tavily-keyless";

  private readonly endpoint: string;
  private readonly fetchFn: FetchFn;
  private readonly timeoutMs: number;

  constructor(options: KeylessTavilySearchProviderOptions = {}) {
    this.endpoint = options.endpoint ?? DEFAULT_TAVILY_SEARCH_ENDPOINT;
    this.fetchFn = options.fetchFn ?? defaultFetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS;
  }

  async search(
    query: string,
    options?: SearchOptions,
  ): Promise<SearchResponse> {
    return postSearch(
      this.endpoint,
      { "X-Tavily-Access-Mode": "keyless" },
      query,
      options,
      this.fetchFn,
      "Tavily keyless",
      this.timeoutMs,
    );
  }
}
