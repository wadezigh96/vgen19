/**
 * Fallback search: try the default (keyed) provider first, and try the
 * keyless fallback once when it fails. Fail closed with both errors
 * named when both fail; there are no further retries.
 */

import { errorMessage } from "../util.js";
import type {
  SearchOptions,
  SearchProvider,
  SearchResponse,
} from "./types.js";
import { SearchError } from "./types.js";

export interface FallbackSearchProviderOptions {
  /** Default provider (keyed Tavily). Tried first for every query. */
  primary: SearchProvider;
  /** Keyless fallback provider. Tried once when the default fails. */
  fallback: SearchProvider;
}

export class FallbackSearchProvider implements SearchProvider {
  readonly name = "fallback";

  private readonly primary: SearchProvider;
  private readonly fallback: SearchProvider;

  constructor(options: FallbackSearchProviderOptions) {
    this.primary = options.primary;
    this.fallback = options.fallback;
  }

  async search(
    query: string,
    options?: SearchOptions,
  ): Promise<SearchResponse> {
    try {
      return await this.primary.search(query, options);
    } catch (primaryError) {
      try {
        return await this.fallback.search(query, options);
      } catch (fallbackError) {
        throw new SearchError(
          `Both search providers failed (${this.primary.name}: ` +
            `${errorMessage(primaryError)}; ${this.fallback.name}: ` +
            `${errorMessage(fallbackError)}).`,
        );
      }
    }
  }
}
