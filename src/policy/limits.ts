/**
 * Policy: the limits the agent enforces, in one module (spec:
 * "a policy module that enforces all limits").
 *
 * The constants used to live scattered across the modules that
 * happened to enforce them (caps in the submitter, the model-call
 * budget in the routed client, the market cap in picking, the review
 * threshold in the draft types). They live here now, with the pure
 * checks over them, and the original modules re-export the constants
 * they used to define so existing imports keep working. The
 * enforcement itself stays where it belongs (the submitter refuses
 * over-cap submissions, picking skips over-cap markets, the runner
 * stops at the time budget); this module is the single source of
 * truth for the numbers and the predicates.
 */

/** Maximum evidence submissions per market (competition rule). */
export const MAX_SUBMISSIONS_PER_MARKET = 3;

/**
 * Default maximum submissions sent in one mining cycle, used when
 * `VGEN19_MAX_SUBMISSIONS_PER_CYCLE` is unset.
 */
export const DEFAULT_MAX_SUBMISSIONS_PER_CYCLE = 5;

/**
 * Default per-cycle model-call budget when `VGEN19_MODEL_CALL_BUDGET`
 * is unset. 50 matches OpenRouter's free daily allowance for an
 * account with no credit purchases, so one cycle can never blow the
 * day's free fallback quota on its own.
 */
export const DEFAULT_MODEL_CALL_BUDGET = 50;

/**
 * Default maximum markets worked in one mining cycle, used when
 * `VGEN19_MAX_MARKETS_PER_CYCLE` is unset.
 */
export const DEFAULT_MAX_MARKETS_PER_CYCLE = 5;

/**
 * Default self-review pass threshold: a draft needs an overall rubric
 * score of at least 0.7 to be approved. Overridable via
 * `VGEN19_REVIEW_PASS_THRESHOLD`.
 */
export const DEFAULT_REVIEW_PASS_THRESHOLD = 0.7;

/**
 * Default per-cycle time budget in minutes, used when
 * `VGEN19_CYCLE_TIME_BUDGET_MINUTES` is unset. The runner stops
 * picking new markets once the deadline passes and finishes
 * normally; the run script's hard `timeout` (60 minutes) sits
 * above it as a backstop.
 */
export const DEFAULT_CYCLE_TIME_BUDGET_MINUTES = 45;

/** True when the market already has the maximum submissions. */
export function atMarketSubmissionCap(submissions: number): boolean {
  return submissions >= MAX_SUBMISSIONS_PER_MARKET;
}

/** True when the cycle already sent its maximum submissions. */
export function atCycleSubmissionCap(
  submissions: number,
  maxSubmissions: number,
): boolean {
  return submissions >= maxSubmissions;
}

/**
 * True when the evidence cutoff is present, parses as a date, and is
 * already past. A missing or unparsable cutoff cannot be enforced,
 * so it counts as not past; the market is then picked and submitted
 * normally.
 */
export function pastEvidenceCutoff(
  cutoff: string | undefined,
  now: Date,
): boolean {
  if (cutoff === undefined) {
    return false;
  }
  const cutoffMs = Date.parse(cutoff);
  if (Number.isNaN(cutoffMs)) {
    return false;
  }
  return cutoffMs <= now.getTime();
}
