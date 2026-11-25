/**
 * Shared Delphi domain types. These mirror the real Delphi API shapes
 * documented at https://docs.delphi.fyi/tools/sdk/api.md (verified
 * 20 November 2026); only the adapter module knows how they map to
 * Delphi endpoints, authentication, and wire formats.
 */

/** Lifecycle of a market on Delphi. */
export type MarketStatus =
  | "open"
  | "awaiting_settlement"
  | "settled"
  | "expired"
  | "failed";

/**
 * Parsed market metadata, in the shape the Delphi API reference
 * documents. `outcomes[0]` labels outcome index 0.
 */
export interface MarketMetadata {
  /** The Yes/No question the market asks. */
  question?: string;
  /** Alternative title. */
  title?: string;
  /** Longer description of the market. */
  description?: string;
  /** Category as recorded in the metadata. */
  category?: string;
  /** Outcome labels; index matches the outcome index. */
  outcomes?: string[];
  /** How the market resolves. */
  resolutionCriteria?: string;
  /** ISO date the market's question resolves by. */
  endDate?: string;
}

/**
 * Competition-2-only fields the spec needs: odds, reward pot, and
 * evidence cutoff. The public Delphi docs do not define them, and
 * the reads API does not return them, so they live in this optional
 * extension. The live client reads them from the competition site's
 * public `/markets.json` (see `markets-json.ts`).
 */
export interface MarketCompetition {
  /** Probability-style odds for Yes. */
  oddsYes?: number;
  /** Probability-style odds for No. */
  oddsNo?: number;
  /** Reward pot available for evidence on this market, in USDC.e. */
  rewardPot?: number;
  /** Judgement pot for this market, in USDC.e. */
  judgementPot?: number;
  /** Settlement pot for this market, in USDC.e. */
  settlementPot?: number;
  /** Evidence cutoff: evidence submitted after this does not count. */
  evidenceCutoff?: string;
  /** Competition tier ("A" or "B") from the market list. */
  tier?: "A" | "B";
  /** Competition wave the market belongs to. */
  wave?: number;
}

/**
 * One Yes/No question on Delphi, in the shape the Delphi API returns.
 * Dates are ISO strings; the API returns several fields as strings
 * that are null when not yet known.
 */
export interface Market {
  /** On-chain contract address of the market proxy. */
  id: string;
  /** UUID identifying the market in the Delphi app UI. */
  appMarketId: string;
  /** Direct link to the market on the Delphi app. */
  marketUrl: string;
  /** Current lifecycle state of the market. */
  status: MarketStatus;
  /** Market category, e.g. "crypto", "sports", "politics". */
  category: string;
  /** Wallet address that deployed/created the market. */
  deployer: string;
  /** Market implementation contract address. */
  implementation: string;
  /** URI pointing to the market metadata. */
  metadataUri: string;
  /** Content hash for the metadata URI. */
  metadataUriContentHash: string;
  /** Parsed market metadata returned by the API, or null. */
  metadata: MarketMetadata | null;
  /**
   * Data sources used for market resolution/verification. The public
   * docs do not define this shape, so it stays `unknown` here.
   */
  dataSources: unknown;
  /** ISO timestamp when the market was created. */
  createdAt: string;
  /** ISO timestamp when metadata was last fetched, or null. */
  fetchedAt: string | null;
  /** Status from the metadata fetch attempt, or null. */
  fetchResponseStatus: string | null;
  /** ISO timestamp when the market is expected to resolve, or null. */
  resolvesAt: string | null;
  /** ISO timestamp when the market was settled, or null. */
  settledAt: string | null;
  /** ISO timestamp for scheduled settlement, or null. */
  settlesAt: string | null;
  /** Winning outcome index after settlement, or null. */
  winningOutcomeIdx: string | null;
  /** Trading fee value returned by the API, or null. */
  tradingFee: string | null;
  /** Resolution proof or verification reference, or null. */
  proof: string | null;
  /** Error message related to market metadata/resolution, or null. */
  error: string | null;
  /** Whether the market has verifiable settlement enabled. */
  verifiable: boolean;
  /**
   * Competition-2-only fields (odds, reward pot, evidence cutoff).
   * See `MarketCompetition`; present on markets from `/markets.json`.
   */
  competition?: MarketCompetition;
}

/**
 * When the market closes (no more trading): the metadata end date
 * when the metadata carries one, otherwise the scheduled settlement
 * time. Undefined when neither is known.
 */
export function marketCloseTime(market: Market): string | undefined {
  return market.metadata?.endDate ?? market.settlesAt ?? undefined;
}

/**
 * The identity the agent sends with every Delphi request, per the
 * competition instructions: agent name, harness, and model.
 */
export interface AgentIdentity {
  /** Registered competitor name, shown on the leaderboard. */
  agentName: string;
  /** The program running the agent (here: the Vgen19 codebase). */
  harness: string;
  /** The model behind the agent's decisions. */
  model: string;
}
