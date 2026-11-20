/**
 * Final summary module: the end-of-competition aggregation (spec
 * story 31) over everything the mining cycles recorded, the
 * scheduled-run index reader, and the Markdown report writer.
 */

export {
  aggregateFinalSummary,
  BEST_EVIDENCE_COUNT,
  NOTE_EXCERPT_CHARS,
  type AggregateFinalSummaryOptions,
} from "./aggregate.js";
export {
  finalSummaryPath,
  formatFinalSummary,
  formatFinalSummaryLine,
  writeFinalSummary,
} from "./report.js";
export { readRunIndex, runIndexPath, runLogPath } from "./runs.js";
export type {
  BestEvidenceEntry,
  FailedCycleEntry,
  FinalSummary,
  FinalSummaryCycleRow,
  FinalSummaryMarketRow,
  RunIndexEntry,
} from "./types.js";
