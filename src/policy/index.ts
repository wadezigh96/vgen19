/**
 * Policy module: the limits the agent enforces (caps, budgets,
 * thresholds) and the pure checks over them. See `limits.ts`.
 */

export {
  atCycleSubmissionCap,
  atMarketSubmissionCap,
  DEFAULT_CYCLE_TIME_BUDGET_MINUTES,
  DEFAULT_MAX_MARKETS_PER_CYCLE,
  DEFAULT_MAX_SUBMISSIONS_PER_CYCLE,
  DEFAULT_MODEL_CALL_BUDGET,
  DEFAULT_REVIEW_PASS_THRESHOLD,
  MAX_SUBMISSIONS_PER_MARKET,
  pastEvidenceCutoff,
} from "./limits.js";
