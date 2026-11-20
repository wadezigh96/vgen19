/**
 * Final summary domain types: the end-of-competition aggregation
 * (spec story 31) over everything the mining cycles recorded.
 *
 * Vocabulary follows GLOSSARY.md: a submission is one evidence
 * delivery to Delphi for one market; judgment and settlement rewards
 * stay attached to the submission that earned them; a mining cycle
 * is one scheduled run. The summary aggregates across all cycles in
 * the data dir; it never invents a number a cycle did not record.
 */

/**
 * One line of `<data-dir>/runs/index.jsonl`, written by the run
 * script (scripts/run-cycle.sh) after every scheduled cycle. The
 * summary reads it to report failed cycles.
 */
export interface RunIndexEntry {
  /** Id of the mining cycle. */
  cycleId: string;
  /** ISO timestamp when the cycle started. */
  startedAt: string;
  /** ISO timestamp when the cycle finished. */
  finishedAt: string;
  /** Exit code of the cycle process (0 on success). */
  exitCode: number;
  /** `ok` when the cycle exited 0, `failed` otherwise. */
  status: "ok" | "failed";
  /** Path of the cycle's per-run log file. */
  logPath: string;
}

/** One market covered, with its submission count and rewards. */
export interface FinalSummaryMarketRow {
  /** Id of the market. */
  marketId: string;
  /** The market's Yes/No question (the id when unknown). */
  question: string;
  /** Submissions sent for this market. */
  submissions: number;
  /** Judgment rewards earned on this market, in USDC. */
  judgmentReward: number;
  /** Settlement rewards earned on this market, in USDC. */
  settlementReward: number;
}

/** One of the best pieces of evidence, by judgment reward. */
export interface BestEvidenceEntry {
  /** Id Delphi assigned to the submission. */
  submissionId: string;
  /** Id of the market the evidence is for. */
  marketId: string;
  /** The market's Yes/No question (the id when unknown). */
  question: string;
  /** The evidence note, truncated to a short excerpt. */
  noteExcerpt: string;
  /** Source links cited by the evidence note. */
  links: string[];
  /** Judgment reward the submission earned, in USDC. */
  judgmentReward: number;
  /** Settlement reward the submission earned, in USDC. */
  settlementReward: number;
}

/** One mining cycle in the per-cycle table. */
export interface FinalSummaryCycleRow {
  /** Id of the mining cycle. */
  cycleId: string;
  /** Run outcome from the run index; `unknown` when never recorded. */
  status: "ok" | "failed" | "unknown";
  /** Markets the cycle worked (from its trace, else its submissions). */
  markets: number;
  /** Drafts the cycle created; null when no trace records it. */
  drafts: number | null;
  /** Submissions the cycle sent. */
  submissions: number;
  /** Judgment rewards earned by the cycle's submissions, in USDC. */
  judgmentReward: number;
  /** Settlement rewards earned by the cycle's submissions, in USDC. */
  settlementReward: number;
  /** Model calls the cycle made; null when no cost record exists. */
  modelCalls: number | null;
  /** Search calls the cycle made; null when no cost record exists. */
  searchCalls: number | null;
}

/** One cycle that failed or left no record of completing. */
export interface FailedCycleEntry {
  /** Id of the mining cycle. */
  cycleId: string;
  /** `failed` when the run index says so; `unknown` when the cycle
   * left neither a cost record nor a report. */
  kind: "failed" | "unknown";
  /** ISO timestamp when the cycle started, when recorded. */
  startedAt?: string;
  /** Exit code of the cycle process, when recorded. */
  exitCode?: number;
  /** Path of the cycle's per-run log file, when recorded. */
  logPath?: string;
  /** Why the cycle is listed here, in words. */
  reason: string;
}

/** The aggregated final summary, across all cycles. */
export interface FinalSummary {
  /** ISO timestamp when the summary was generated. */
  generatedAt: string;
  /** Totals across the whole competition window. */
  totals: {
    /** Submissions sent in total. */
    submissions: number;
    /** Submissions Delphi accepted. */
    accepted: number;
    /** Submissions Delphi judged. */
    judged: number;
    /** Submissions Delphi rejected. */
    rejected: number;
    /** Markets with at least one submission. */
    marketsCovered: number;
    /** Judgment rewards in total, in USDC. */
    judgmentReward: number;
    /** Settlement rewards in total, in USDC. */
    settlementReward: number;
    /** All rewards in total, in USDC. */
    totalReward: number;
    /** Model calls in total, across cost records. */
    modelCalls: number;
    /** Search calls in total, across cost records. */
    searchCalls: number;
    /** Search credits in total, across cost records. */
    searchCreditsUsed: number;
    /** Mining cycles known (cost records, traces, run index, submissions). */
    cycles: number;
    /** Cycles listed as failed or unknown. */
    failedCycles: number;
  };
  /** Markets covered, most submissions first. */
  markets: FinalSummaryMarketRow[];
  /** The best evidence: top 5 submissions by judgment reward. */
  bestEvidence: BestEvidenceEntry[];
  /** One row per known cycle, in run order. */
  cycles: FinalSummaryCycleRow[];
  /** Cycles that failed or left no record of completing. */
  failures: FailedCycleEntry[];
}
