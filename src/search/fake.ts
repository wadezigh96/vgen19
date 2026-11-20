/**
 * In-memory fake search provider for tests. Later tickets import it
 * from here so their tests never need a real key or the network.
 *
 * The fake plays a script of outcomes in order (results or failures)
 * and falls back to per-query results, then to `results`, once the
 * script runs out. Every query is recorded, including failed ones.
 */

import type {
  SearchOptions,
  SearchProvider,
  SearchResponse,
  SearchResult,
} from "./types.js";

export type FakeSearchOutcome =
  | { results: SearchResult[] }
  | { error: Error };

export interface FakeSearchProviderOptions {
  /** Outcomes played in order; when exhausted, the canned results apply. */
  script?: FakeSearchOutcome[];
  /** Results returned for a query with no per-query entry. */
  results?: SearchResult[];
  /** Results returned for one specific query. */
  resultsByQuery?: Record<string, SearchResult[]>;
}

export class FakeSearchProvider implements SearchProvider {
  readonly name = "fake-search";

  /** Every query asked, in order, including failed ones. */
  readonly queries: string[] = [];

  private readonly script: FakeSearchOutcome[];
  private readonly defaultResults: SearchResult[];
  private readonly resultsByQuery: Record<string, SearchResult[]>;

  constructor(options: FakeSearchProviderOptions = {}) {
    this.script = [...(options.script ?? [])];
    this.defaultResults = [...(options.results ?? [])];
    this.resultsByQuery = { ...(options.resultsByQuery ?? {}) };
  }

  /** Append scripted results to the end of the script. */
  queueResults(results: SearchResult[]): void {
    this.script.push({ results });
  }

  /** Append a failure to the end of the script. */
  queueError(error: Error): void {
    this.script.push({ error });
  }

  async search(
    query: string,
    _options?: SearchOptions,
  ): Promise<SearchResponse> {
    this.queries.push(query);
    const outcome = this.script.shift();
    if (outcome !== undefined) {
      if ("error" in outcome) {
        throw outcome.error;
      }
      return { results: outcome.results, usage: { credits: 1 } };
    }
    const perQuery = this.resultsByQuery[query];
    if (perQuery !== undefined) {
      return { results: perQuery, usage: { credits: 1 } };
    }
    return { results: this.defaultResults, usage: { credits: 1 } };
  }
}
