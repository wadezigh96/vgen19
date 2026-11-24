/**
 * Delphi adapter module.
 *
 * This is the single boundary between Vgen19 and Delphi: only this
 * module knows Delphi endpoints, authentication, and wire formats.
 * `createDelphiAdapter` is the one plug-in point: it returns the
 * live client when a Delphi API key is configured, and the stub
 * adapter (recorded fixtures, no network) as the no-key fallback.
 * The stub stays intact for tests and for stub cycles.
 */

import type { DelphiAdapter } from "./adapter.js";
import { AGENT_NAME, HARNESS } from "../agent.js";
import { LiveDelphiAdapter } from "./live.js";
import { STUB_IDENTITY, StubDelphiAdapter } from "./stub.js";
import type { AgentIdentity } from "./types.js";

export type {
  DelphiAdapter,
  GetMarketParams,
  ListMarketsParams,
  MarketOrderBy,
} from "./adapter.js";
export {
  baseUnitsToUsdcE,
  EvidenceApiError,
  TERMINAL_SUBMISSION_STATUSES,
  TermsNotAcceptedError,
  USDC_BASE_UNITS_PER_TOKEN,
  type EntryState,
  type EvidenceErrorCode,
  type EvidenceLimits,
  type EvidenceMeta,
  type EvidenceResult,
  type EvidenceTerms,
  type RateLimitName,
  type Submission,
  type SubmissionMarket,
  type SubmissionStatus,
  type SubmissionSummary,
  type TermsAcceptance,
} from "./evidence.js";
export { fixtureMarkets } from "./fixtures.js";
export {
  DELPHI_APP_URL,
  DELPHI_EVIDENCE_BASE_URL,
  DELPHI_READS_BASE_URL,
  DelphiReadError,
  LiveDelphiAdapter,
  type LiveDelphiClientOptions,
} from "./live.js";
export { STUB_IDENTITY, StubDelphiAdapter } from "./stub.js";
export type { RecordedSubmission } from "./stub.js";
export {
  SYNC_PAGE_SIZE,
  syncMarkets,
  type MarketSyncResult,
} from "./sync.js";
export { marketCloseTime } from "./types.js";
export type {
  AgentIdentity,
  Market,
  MarketCompetition,
  MarketMetadata,
  MarketStatus,
} from "./types.js";

/**
 * Options for `createDelphiAdapter`. Only `apiKey` decides which
 * adapter is built; the rest configure the live client.
 */
export interface CreateDelphiAdapterOptions {
  /**
   * The Delphi API key. When set (and non-blank), the live client
   * is built; otherwise the stub is. From `DELPHI_API_ACCESS_KEY`
   * (`DELPHI_API_KEY` also works as an alias).
   */
  apiKey?: string;
  /**
   * Optional separate key for reads only (the placement escape
   * hatch). From `DELPHI_API_READ_KEY` when set.
   */
  readApiKey?: string;
  /** Fetch override for tests. Defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Reads base URL override for the live client. */
  readsBaseUrl?: string;
  /** Evidence base URL override for the live client. */
  evidenceBaseUrl?: string;
  /** Delphi app URL override for the live client. */
  appUrl?: string;
}

/**
 * Build the Delphi adapter the agent talks to: the live client
 * when a Delphi API key is configured, the stub otherwise. This is
 * the single plug-in point; no other module needs to change.
 */
export function createDelphiAdapter(
  identity: AgentIdentity = STUB_IDENTITY,
  options: CreateDelphiAdapterOptions = {},
): DelphiAdapter {
  const apiKey = options.apiKey?.trim() ?? "";
  if (apiKey === "") {
    return new StubDelphiAdapter(identity);
  }
  return new LiveDelphiAdapter({
    apiKey,
    appUrl: options.appUrl,
    evidenceBaseUrl: options.evidenceBaseUrl,
    fetch: options.fetch,
    identity,
    readApiKey: options.readApiKey,
    readsBaseUrl: options.readsBaseUrl,
  });
}

/**
 * Build the adapter the commands use: the Vgen19 identity with the
 * given model (the strong model, so Delphi sees the model that
 * drafted the evidence), and the live client when a key is
 * configured, the stub otherwise.
 */
export function createConfiguredDelphiAdapter(
  model: string,
  options: CreateDelphiAdapterOptions = {},
): DelphiAdapter {
  return createDelphiAdapter(
    { agentName: AGENT_NAME, harness: HARNESS, model },
    options,
  );
}
