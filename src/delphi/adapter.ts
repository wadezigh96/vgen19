/**
 * The Delphi adapter boundary.
 *
 * This module (and only this module) knows Delphi endpoints,
 * authentication, and wire formats. Everything else in the agent talks
 * to Delphi through the `DelphiAdapter` interface below, so the live
 * wiring lands as one contained change (ticket 08) without touching
 * other modules.
 *
 * Until the official API is published on 23 November 2026, the stub
 * implementation in `stub.ts` stands in and returns recorded fixtures.
 * The stub mentions no endpoints, no authentication, and no formats.
 */

import type { AgentIdentity, Market, MarketStatus } from "./types.js";
import type { EvidenceDraft } from "../draft/types.js";

/** Sort order for `listMarkets`, as documented by the Delphi API. */
export type MarketOrderBy = "liquidity" | "created" | "settles_at";

/**
 * Filters and pagination for `listMarkets`, matching the parameters
 * the Delphi API documents. Every field is optional; the API defaults
 * `competitionId` to the active competition.
 */
export interface ListMarketsParams {
  /** Only markets in this lifecycle state. */
  status?: MarketStatus;
  /** Only markets in this category (matches the metadata category). */
  category?: string;
  /** How the API orders the results. */
  orderBy?: MarketOrderBy;
  /** Only markets with verifiable settlement. */
  verifiable?: boolean;
  /** Pagination offset (default 0). */
  skip?: number;
  /** Maximum markets returned (API default 50). */
  limit?: number;
  /** Competition to query (defaults to the active competition). */
  competitionId?: string;
  /** Include prices and implied probabilities. */
  pricesAndImpliedProbabilities?: boolean;
}

/** Parameters for `getMarket`: the market's contract address. */
export interface GetMarketParams {
  /** On-chain market contract address (the `id` from `listMarkets`). */
  id: string;
  /** Competition to query (defaults to the active competition). */
  competitionId?: string;
}

/**
 * The agent's view of Delphi. Ticket 06 adds submission (the stub
 * answers with a canned receipt until the live client lands in
 * ticket 08); market listing plus the health check is all ticket 03
 * needs.
 */
export interface DelphiAdapter {
  /** The identity sent with every request (agent name, harness, model). */
  readonly identity: AgentIdentity;
  /** Read the competition market list, with optional filtering. */
  listMarkets(params?: ListMarketsParams): Promise<Market[]>;
  /** Read one market by its contract address. */
  getMarket(params: GetMarketParams): Promise<Market>;
  /** Check service availability. Needs no authentication. */
  health(): Promise<{ status: string }>;
  /**
   * Send one approved evidence draft to Delphi. `meta` is the
   * identity sent with the request (agent name, harness, and the
   * model that drafted the evidence); it may differ from the
   * adapter's default identity when a different model drafted.
   *
   * Returns the raw receipt value: the submitter parses it strictly
   * (`parseSubmissionReceipt`) before trusting anything in it, so a
   * changed receipt shape fails loudly instead of recording garbage.
   */
  submitEvidence(
    draft: EvidenceDraft,
    meta: AgentIdentity,
  ): Promise<unknown>;
}
