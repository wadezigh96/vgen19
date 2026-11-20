/**
 * Mining cycle module: the runner that owns one full cycle (sync,
 * pick, research, draft, submit, receipts, report), market picking,
 * the JSONL trace, cost tracking, and the per-cycle report.
 */

export {
  CountingModelClient,
  CountingSearchProvider,
  createModelCallCounter,
  cycleCostPath,
  writeCostRecord,
  type CycleCostRecord,
  type CycleModel,
  type ModelCallCounter,
} from "./costs.js";
export {
  DEFAULT_MAX_MARKETS_PER_CYCLE,
  pickMarkets,
  type MarketSkipReason,
  type PickMarketsOptions,
  type PickMarketsResult,
  type SkippedMarket,
} from "./picking.js";
export {
  cycleReportPath,
  formatCycleReport,
  formatCycleSummaryLine,
  writeCycleReport,
  type CycleDraftInfo,
  type CycleRefusalInfo,
  type CycleSubmissionInfo,
  type CycleSummary,
} from "./report.js";
export { runCycle, type CycleDeps } from "./runner.js";
export {
  cycleTracePath,
  TraceWriter,
  type TraceEntry,
  type TraceStep,
} from "./trace.js";
