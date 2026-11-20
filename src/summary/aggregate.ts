/**
 * The final summary aggregator (spec story 31): the end-of-competition
 * summary over everything the mining cycles recorded.
 *
 * Aggregation reads the memory store (markets, submissions, rewards,
 * drafts), the per-cycle cost records, the per-cycle traces, the
 * per-cycle reports (existence only), and the scheduled-run index,
 * and returns one `FinalSummary`. It is pure over those inputs: given
 * the same data dir it returns the same summary, so it is
 * unit-testable with a seeded temp data dir. No live network, no
 * credentials, no writes.
 *
 * File-based sources are read tolerantly: a missing directory means
 * no records yet, a malformed file or line is skipped, and a cycle
 * the data cannot describe is reported as unknown rather than
 * guessed at. A cycle is listed as a failure when the run index says
 * it failed, or when it left neither a cost record nor a report.
 */

import { access, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { CycleCostRecord } from "../cycle/costs.js";
import { cycleReportPath } from "../cycle/report.js";
import type { TraceEntry } from "../cycle/trace.js";
import { MemoryStore } from "../memory/store.js";
import type { RewardRecord } from "../submit/types.js";
import { readRunIndex } from "./runs.js";
import type {
  BestEvidenceEntry,
  FailedCycleEntry,
  FinalSummary,
  FinalSummaryCycleRow,
  FinalSummaryMarketRow,
  RunIndexEntry,
} from "./types.js";

/** How many submissions the best-evidence list keeps. */
export const BEST_EVIDENCE_COUNT = 5;
/** Characters kept in a best-evidence note excerpt. */
export const NOTE_EXCERPT_CHARS = 200;

export interface AggregateFinalSummaryOptions {
  /** Clock seam for the generated timestamp. */
  now?: () => Date;
}

async function listFiles(
  dir: string,
  suffix: string,
): Promise<string[]> {
  try {
    const names = await readdir(dir);
    return names.filter((name) => name.endsWith(suffix)).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function isCostRecord(value: unknown): value is CycleCostRecord {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  // Finiteness matters: a hand-edited cost file can carry 1e999,
  // which JSON parses to Infinity and would poison the totals.
  return (
    typeof record["cycleId"] === "string" &&
    typeof record["modelCalls"] === "number" &&
    Number.isFinite(record["modelCalls"]) &&
    typeof record["searchCalls"] === "number" &&
    Number.isFinite(record["searchCalls"]) &&
    typeof record["searchCreditsUsed"] === "number" &&
    Number.isFinite(record["searchCreditsUsed"]) &&
    typeof record["recordedAt"] === "string"
  );
}

async function readCostRecords(
  dataDir: string,
): Promise<Map<string, CycleCostRecord>> {
  const records = new Map<string, CycleCostRecord>();
  const costsDir = join(dataDir, "costs");
  for (const name of await listFiles(costsDir, ".json")) {
    try {
      const parsed: unknown = JSON.parse(
        await readFile(join(costsDir, name), "utf-8"),
      );
      if (isCostRecord(parsed)) {
        records.set(parsed.cycleId, parsed);
      }
    } catch {
      // A malformed cost file is skipped, never fatal.
    }
  }
  return records;
}

interface TraceSummary {
  /** Markets the trace saw a market-start for. */
  markets: Set<string>;
  /** Drafts the trace saw created. */
  drafts: number;
}

async function readTraceSummaries(
  dataDir: string,
): Promise<Map<string, TraceSummary>> {
  const summaries = new Map<string, TraceSummary>();
  const tracesDir = join(dataDir, "traces");
  for (const name of await listFiles(tracesDir, ".jsonl")) {
    const cycleId = name.slice(0, -".jsonl".length);
    const summary: TraceSummary = { drafts: 0, markets: new Set<string>() };
    try {
      const raw = await readFile(join(tracesDir, name), "utf-8");
      for (const line of raw.split("\n")) {
        if (line.trim() === "") {
          continue;
        }
        try {
          const entry = JSON.parse(line) as TraceEntry;
          if (entry.step === "market-start" && entry.marketId !== undefined) {
            summary.markets.add(entry.marketId);
          } else if (entry.step === "draft-created") {
            summary.drafts += 1;
          }
        } catch {
          // A malformed trace line is skipped, never fatal.
        }
      }
    } catch {
      // An unreadable trace file is skipped, never fatal.
    }
    summaries.set(cycleId, summary);
  }
  return summaries;
}

async function reportExists(dataDir: string, cycleId: string): Promise<boolean> {
  try {
    await access(cycleReportPath(dataDir, cycleId));
    return true;
  } catch {
    return false;
  }
}

function truncateNote(note: string): string {
  if (note.length <= NOTE_EXCERPT_CHARS) {
    return note;
  }
  return `${note.slice(0, NOTE_EXCERPT_CHARS)}…`;
}

/** Sort key for cycles: known start times first, then by cycle id. */
function cycleSortKey(
  cycleId: string,
  startedAt: string | undefined,
): [string, string] {
  return [startedAt ?? "9999", cycleId];
}

function compareCycleKeys(
  a: [string, string],
  b: [string, string],
): number {
  if (a[0] !== b[0]) {
    return a[0] < b[0] ? -1 : 1;
  }
  if (a[1] !== b[1]) {
    return a[1] < b[1] ? -1 : 1;
  }
  return 0;
}

/**
 * Aggregate the final summary over all cycles in the data dir.
 * Reads only; writes nothing.
 */
export async function aggregateFinalSummary(
  dataDir: string,
  options: AggregateFinalSummaryOptions = {},
): Promise<FinalSummary> {
  const now = options.now ?? (() => new Date());
  const store = new MemoryStore(dataDir);
  const [markets, submissions, rewards, drafts, costs, traces, runIndex] =
    await Promise.all([
      store.loadMarkets(),
      store.loadSubmissions(),
      store.loadRewards(),
      store.loadDrafts(),
      readCostRecords(dataDir),
      readTraceSummaries(dataDir),
      readRunIndex(dataDir),
    ]);

  const questionByMarket = new Map<string, string>();
  for (const market of markets) {
    questionByMarket.set(
      market.id,
      market.metadata?.question ?? market.metadata?.title ?? market.id,
    );
  }
  const questionFor = (marketId: string): string =>
    questionByMarket.get(marketId) ?? marketId;

  const rewardBySubmission = new Map<string, RewardRecord>();
  for (const reward of rewards) {
    rewardBySubmission.set(reward.submissionId, reward);
  }
  const draftById = new Map(drafts.map((draft) => [draft.id, draft]));

  // The last run index entry per cycle wins: a re-run supersedes
  // the earlier attempt.
  const runByCycle = new Map<string, RunIndexEntry>();
  for (const entry of runIndex) {
    runByCycle.set(entry.cycleId, entry);
  }

  // Every known cycle: cost records, traces, run index, submissions.
  const cycleIds = new Set<string>([
    ...costs.keys(),
    ...traces.keys(),
    ...runByCycle.keys(),
    ...submissions.map((submission) => submission.cycleId),
  ]);

  // Per-cycle submissions and rewards, from the store.
  const submissionsByCycle = new Map<string, typeof submissions>();
  for (const submission of submissions) {
    const list = submissionsByCycle.get(submission.cycleId) ?? [];
    list.push(submission);
    submissionsByCycle.set(submission.cycleId, list);
  }

  const cycleRows: FinalSummaryCycleRow[] = [];
  for (const cycleId of cycleIds) {
    const cycleSubmissions = submissionsByCycle.get(cycleId) ?? [];
    const trace = traces.get(cycleId);
    const cost = costs.get(cycleId);
    const run = runByCycle.get(cycleId);
    let judgmentReward = 0;
    let settlementReward = 0;
    for (const submission of cycleSubmissions) {
      const reward = rewardBySubmission.get(submission.id);
      judgmentReward += reward?.judgment ?? 0;
      settlementReward += reward?.settlement ?? 0;
    }
    const marketsWorked =
      trace !== undefined
        ? trace.markets.size
        : new Set(cycleSubmissions.map((submission) => submission.marketId))
            .size;
    cycleRows.push({
      cycleId,
      drafts: trace !== undefined ? trace.drafts : null,
      judgmentReward,
      markets: marketsWorked,
      modelCalls: cost !== undefined ? cost.modelCalls : null,
      searchCalls: cost !== undefined ? cost.searchCalls : null,
      settlementReward,
      status: run !== undefined ? run.status : "unknown",
      submissions: cycleSubmissions.length,
    });
  }
  cycleRows.sort((a, b) =>
    compareCycleKeys(
      cycleSortKey(a.cycleId, runByCycle.get(a.cycleId)?.startedAt),
      cycleSortKey(b.cycleId, runByCycle.get(b.cycleId)?.startedAt),
    ),
  );

  // Failures: cycles the run index says failed, plus cycles that
  // left neither a cost record nor a report.
  const failures: FailedCycleEntry[] = [];
  for (const row of cycleRows) {
    const run = runByCycle.get(row.cycleId);
    if (run !== undefined && run.status === "failed") {
      failures.push({
        cycleId: row.cycleId,
        exitCode: run.exitCode,
        kind: "failed",
        logPath: run.logPath,
        reason: `siklus gagal dengan exit code ${run.exitCode}`,
        startedAt: run.startedAt,
      });
      continue;
    }
    if (costs.has(row.cycleId)) {
      continue;
    }
    if (await reportExists(dataDir, row.cycleId)) {
      continue;
    }
    failures.push({
      cycleId: row.cycleId,
      kind: "unknown",
      reason:
        "tidak ada catatan biaya atau laporan untuk siklus ini",
      ...(run !== undefined ? { startedAt: run.startedAt } : {}),
      ...(run !== undefined ? { logPath: run.logPath } : {}),
    });
  }
  failures.sort((a, b) =>
    compareCycleKeys(
      cycleSortKey(a.cycleId, a.startedAt),
      cycleSortKey(b.cycleId, b.startedAt),
    ),
  );

  // Markets covered: distinct markets among submissions.
  const marketRows = new Map<string, FinalSummaryMarketRow>();
  for (const submission of submissions) {
    const row = marketRows.get(submission.marketId) ?? {
      judgmentReward: 0,
      marketId: submission.marketId,
      question: questionFor(submission.marketId),
      settlementReward: 0,
      submissions: 0,
    };
    row.submissions += 1;
    const reward = rewardBySubmission.get(submission.id);
    row.judgmentReward += reward?.judgment ?? 0;
    row.settlementReward += reward?.settlement ?? 0;
    marketRows.set(submission.marketId, row);
  }
  const marketsSorted = [...marketRows.values()].sort((a, b) => {
    if (a.submissions !== b.submissions) {
      return b.submissions - a.submissions;
    }
    return a.question < b.question ? -1 : a.question > b.question ? 1 : 0;
  });

  // Best evidence: top 5 submissions by judgment reward (only
  // submissions that actually earned a judgment reward).
  const ranked = submissions
    .map((submission) => ({
      judgment: rewardBySubmission.get(submission.id)?.judgment ?? 0,
      settlement: rewardBySubmission.get(submission.id)?.settlement ?? 0,
      submission,
    }))
    .filter((entry) => entry.judgment > 0)
    .sort((a, b) => {
      if (a.judgment !== b.judgment) {
        return b.judgment - a.judgment;
      }
      const totalA = a.judgment + a.settlement;
      const totalB = b.judgment + b.settlement;
      if (totalA !== totalB) {
        return totalB - totalA;
      }
      return a.submission.id < b.submission.id
        ? -1
        : a.submission.id > b.submission.id
          ? 1
          : 0;
    })
    .slice(0, BEST_EVIDENCE_COUNT);
  const bestEvidence: BestEvidenceEntry[] = ranked.map(
    ({ judgment, settlement, submission }) => {
      const draft = draftById.get(submission.draftId);
      return {
        judgmentReward: judgment,
        links: draft !== undefined ? draft.links.map((link) => link.url) : [],
        marketId: submission.marketId,
        noteExcerpt:
          draft !== undefined ? truncateNote(draft.note) : "",
        question: questionFor(submission.marketId),
        settlementReward: settlement,
        submissionId: submission.id,
      };
    },
  );

  // Totals.
  let accepted = 0;
  let judged = 0;
  let rejected = 0;
  for (const submission of submissions) {
    if (submission.receipt.verdict === "accepted") {
      accepted += 1;
    } else if (submission.receipt.verdict === "judged") {
      judged += 1;
    } else {
      rejected += 1;
    }
  }
  let judgmentReward = 0;
  let settlementReward = 0;
  for (const reward of rewards) {
    judgmentReward += reward.judgment ?? 0;
    settlementReward += reward.settlement ?? 0;
  }
  let modelCalls = 0;
  let searchCalls = 0;
  let searchCreditsUsed = 0;
  for (const cost of costs.values()) {
    modelCalls += cost.modelCalls;
    searchCalls += cost.searchCalls;
    searchCreditsUsed += cost.searchCreditsUsed;
  }

  return {
    bestEvidence,
    cycles: cycleRows,
    failures,
    generatedAt: now().toISOString(),
    markets: marketsSorted,
    totals: {
      accepted,
      cycles: cycleIds.size,
      failedCycles: failures.length,
      judged,
      judgmentReward,
      marketsCovered: marketRows.size,
      modelCalls,
      rejected,
      searchCalls,
      searchCreditsUsed,
      settlementReward,
      submissions: submissions.length,
      totalReward: judgmentReward + settlementReward,
    },
  };
}
