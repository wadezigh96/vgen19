/**
 * Web search module: the pluggable provider interface, the Tavily
 * free-tier default, the keyless fallback, and the fake for tests.
 */

export {
  FallbackSearchProvider,
  type FallbackSearchProviderOptions,
} from "./fallback.js";
export {
  buildSearchProvider,
  type SearchProviderConfig,
} from "./factory.js";
export {
  FakeSearchProvider,
  type FakeSearchOutcome,
  type FakeSearchProviderOptions,
} from "./fake.js";
export {
  DEFAULT_TAVILY_SEARCH_ENDPOINT,
  KeylessTavilySearchProvider,
  TavilySearchProvider,
  type KeylessTavilySearchProviderOptions,
  type TavilySearchProviderOptions,
} from "./tavily.js";
export {
  SearchError,
  type SearchOptions,
  type SearchProvider,
  type SearchResponse,
  type SearchResult,
} from "./types.js";
