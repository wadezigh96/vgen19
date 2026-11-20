/**
 * Minimal HTTP seam for model providers. Providers take an injectable
 * `fetch` so tests can stub HTTP behavior without touching the live
 * network. In production the global `fetch` (Node 20+) is used.
 */

export interface FetchInit {
  method: string;
  headers: Record<string, string>;
  body: string;
  /** Abort signal: providers pass `AbortSignal.timeout(...)` so a hung call fails instead of hanging forever. */
  signal?: AbortSignal;
}

export interface FetchResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export type FetchFn = (url: string, init: FetchInit) => Promise<FetchResponse>;

/** Default timeout for one model call: 60 seconds. */
export const DEFAULT_MODEL_TIMEOUT_MS = 60_000;
/** Default timeout for one search call: 30 seconds. */
export const DEFAULT_SEARCH_TIMEOUT_MS = 30_000;

/** The global fetch, adapted to the minimal seam above. */
export const defaultFetch: FetchFn = (url, init) => fetch(url, init);
