/**
 * Shared types for web search: the pluggable provider interface, the
 * result shape, and the error a search can raise.
 *
 * Search results are leads, not facts: the researcher only uses a
 * claim after reading the source page behind the result (spec story 5).
 * Search output is untrusted data, like everything fetched from the
 * web; it is never treated as instructions.
 */

/** One search result: a lead pointing at a source page. */
export interface SearchResult {
  /** Page title, as the search provider returned it. */
  title: string;
  /** URL of the source page. */
  url: string;
  /** Text snippet from the page. Tavily calls this field `content`. */
  snippet: string;
  /**
   * Publication date of the source, when the provider knows it
   * (Tavily returns `published_date`, e.g. "Tue, 11 Mar 2025 17:00:00
   * GMT"). Absent when unknown; never invented.
   */
  publishedDate?: string;
}

export interface SearchOptions {
  /** Maximum results to return. Tavily accepts 0-20 and defaults to 5. */
  maxResults?: number;
}

export interface SearchResponse {
  results: SearchResult[];
  /**
   * Usage the provider reported for this search. Tavily reports
   * `usage.credits` (1 for a basic-depth search); the cycle cost
   * record sums these. Absent when the provider reports nothing.
   */
  usage?: { credits: number };
}

/**
 * One search provider. The default is the Tavily free tier; the
 * fallback is a keyless search (see `tavily.ts`). Providers are
 * pluggable behind this interface so the researcher never knows which
 * one answered.
 */
export interface SearchProvider {
  /** Human-readable provider name, used in error messages and traces. */
  readonly name: string;
  search(query: string, options?: SearchOptions): Promise<SearchResponse>;
}

/** A search failed: network error, non-2xx status, or bad response. */
export class SearchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SearchError";
  }
}
