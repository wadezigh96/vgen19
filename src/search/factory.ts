/**
 * The shared search provider factory: keyed Tavily with a keyless
 * fallback when `TAVILY_API_KEY` is set, keyless-only search
 * otherwise. The `research`, `draft`, and `mine` commands all build
 * their search provider here, so the fallback behaviour stays the
 * same everywhere.
 */

import { FallbackSearchProvider } from "./fallback.js";
import {
  KeylessTavilySearchProvider,
  TavilySearchProvider,
} from "./tavily.js";
import type { SearchProvider } from "./types.js";

/** The configuration the factory reads: only the search settings. */
export interface SearchProviderConfig {
  /** Tavily API key, when configured. */
  tavilyApiKey?: string;
  /** Tavily search endpoint. */
  tavilySearchEndpoint: string;
}

/**
 * Build the search provider for a run. Returns the provider plus
 * whether it is keyless-only (no key configured), so the caller can
 * say so in its output.
 */
export function buildSearchProvider(config: SearchProviderConfig): {
  provider: SearchProvider;
  keylessOnly: boolean;
} {
  const keyless = new KeylessTavilySearchProvider({
    endpoint: config.tavilySearchEndpoint,
  });
  if (config.tavilyApiKey === undefined) {
    return { keylessOnly: true, provider: keyless };
  }
  return {
    keylessOnly: false,
    provider: new FallbackSearchProvider({
      fallback: keyless,
      primary: new TavilySearchProvider({
        apiKey: config.tavilyApiKey,
        endpoint: config.tavilySearchEndpoint,
      }),
    }),
  };
}
