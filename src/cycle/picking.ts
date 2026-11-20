/**
 * Market picking for a mining cycle: which synced markets the cycle
 * works, and which it skips.
 *
 * Picking is pure over the synced markets plus what memory already
 * knows, so it is unit-testable without a store or an adapter:
 *
 * - Newly opened markets come first: a market is new when its id was
 *   not in the store before this cycle's sync (first-seen in this
 *   cycle), so its evidence arrives before anyone else submits the
 *   same facts (spec story 3).
 * - Among equally new markets, the fewest submissions so far win,
 *   so effort goes where rewards are still possible (spec story 2).
 * - Fully covered markets are skipped: 3 submissions already recorded
 *   is the per-market cap (competition rule, spec story 12).
 * - Non-open markets are skipped: evidence for a market that is no
 *   longer open does not count.
 * - Markets past their evidence cutoff are skipped: evidence after
 *   the cutoff does not count (the submitter refuses them too, as a
 *   backstop). Markets without a cutoff are never skipped for this
 *   reason.
 * - The number of targets is capped per cycle (config
 *   `VGEN19_MAX_MARKETS_PER_CYCLE`, default 5); markets past the cap
 *   are skipped as `over-cap` and may be picked in a later cycle.
 *
 * The order is deterministic: a stable sort by (new first, fewest
 * submissions, sync order), no randomness anywhere. The clock is an
 * explicit input (`now`), so the cutoff check is deterministic and
 * testable.
 */

import type { Market } from "../delphi/types.js";
import {
  DEFAULT_MAX_MARKETS_PER_CYCLE,
  MAX_SUBMISSIONS_PER_MARKET,
  pastEvidenceCutoff,
} from "../policy/limits.js";

export { DEFAULT_MAX_MARKETS_PER_CYCLE } from "../policy/limits.js";

/** Why a synced market was not picked for this cycle. */
export type MarketSkipReason =
  /** The market is not open (awaiting settlement, settled, expired, failed). */
  | "not-open"
  /** The market already has 3 submissions (the per-market cap). */
  | "fully-covered"
  /** The market's evidence cutoff has passed. */
  | "past-cutoff"
  /** The market lost out to the per-cycle target cap. */
  | "over-cap";

/** One synced market the cycle did not pick, with the reason. */
export interface SkippedMarket {
  /** The market that was skipped. */
  market: Market;
  /** Why it was skipped. */
  reason: MarketSkipReason;
}

export interface PickMarketsOptions {
  /**
   * Market ids already in the memory store before this cycle's sync.
   * A synced market whose id is not in this set is newly opened.
   */
  previouslyStoredIds: ReadonlySet<string>;
  /** Submissions already recorded per market id, across all cycles. */
  submissionsByMarket: Readonly<Record<string, number>>;
  /** Maximum targets to pick. Defaults to `DEFAULT_MAX_MARKETS_PER_CYCLE`. */
  maxMarkets?: number;
  /** The current time, against which evidence cutoffs are checked. Required. */
  now: Date;
}

export interface PickMarketsResult {
  /** Markets the cycle will work, in the order it works them. */
  picked: Market[];
  /** Markets the cycle will not work, with the reason for each. */
  skipped: SkippedMarket[];
}

export function pickMarkets(
  synced: Market[],
  options: PickMarketsOptions,
): PickMarketsResult {
  const maxMarkets =
    options.maxMarkets ?? DEFAULT_MAX_MARKETS_PER_CYCLE;
  const skipped: SkippedMarket[] = [];

  const candidates = synced
    .map((market, index) => ({ index, market }))
    .filter(({ market }) => {
      if (market.status !== "open") {
        skipped.push({ market, reason: "not-open" });
        return false;
      }
      if (pastEvidenceCutoff(market.competition?.evidenceCutoff, options.now)) {
        skipped.push({ market, reason: "past-cutoff" });
        return false;
      }
      const submissions = options.submissionsByMarket[market.id] ?? 0;
      if (submissions >= MAX_SUBMISSIONS_PER_MARKET) {
        skipped.push({ market, reason: "fully-covered" });
        return false;
      }
      return true;
    })
    .map(({ index, market }) => ({
      index,
      isNew: !options.previouslyStoredIds.has(market.id),
      market,
      submissions: options.submissionsByMarket[market.id] ?? 0,
    }));

  // Stable sort: new markets first, then fewest submissions, then
  // sync order (the explicit index tiebreak keeps the order stable
  // even if the runtime sort were not).
  candidates.sort((a, b) => {
    if (a.isNew !== b.isNew) {
      return a.isNew ? -1 : 1;
    }
    if (a.submissions !== b.submissions) {
      return a.submissions - b.submissions;
    }
    return a.index - b.index;
  });

  const picked = candidates.slice(0, maxMarkets).map(({ market }) => market);
  for (const { market } of candidates.slice(maxMarkets)) {
    skipped.push({ market, reason: "over-cap" });
  }
  return { picked, skipped };
}
