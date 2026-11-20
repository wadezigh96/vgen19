/**
 * Delphi adapter module.
 *
 * This is the single boundary between Vgen19 and Delphi: only this
 * module knows Delphi endpoints, authentication, and wire formats.
 * Until the official API is published on 23 November 2026, the stub
 * adapter below stands in with recorded fixtures. Ticket 08 replaces
 * the stub with the live client at the one plug-in point in
 * `createDelphiAdapter`, without touching other modules.
 */

import type { DelphiAdapter } from "./adapter.js";
import { STUB_IDENTITY, StubDelphiAdapter } from "./stub.js";
import type { AgentIdentity } from "./types.js";

export type {
  DelphiAdapter,
  GetMarketParams,
  ListMarketsParams,
  MarketOrderBy,
} from "./adapter.js";
export { fixtureMarkets } from "./fixtures.js";
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
 * Build the Delphi adapter the agent talks to.
 *
 * TODO(ticket 08): return the live client (built from the official
 * guide published 23 November 2026) when a Delphi API key is
 * configured, and keep the stub only as the no-key fallback. This is
 * the single plug-in point; no other module needs to change.
 */
export function createDelphiAdapter(
  identity: AgentIdentity = STUB_IDENTITY,
): DelphiAdapter {
  return new StubDelphiAdapter(identity);
}
