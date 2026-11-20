/**
 * The mining cycle runner: one command runs a complete mining cycle
 * (spec stories 13-16, 22, 25-27).
 *
 * Flow: sync markets (reusing the ticket-03 sync), pick targets
 * (preferring newly opened markets), then for each target in order:
 * submit any approved draft left over from a previous cycle, run the
 * draft pipeline (research, draft, review, submit), and record the
 * receipt. Finally write the report, the JSONL trace, and the cost
 * record, and return a cycle summary.
 *
 * Memory is the source of truth, so a cycle is idempotent:
 *
 * - A market at the per-market cap (3 submissions) is skipped by
 *   picking, and the submitter re-checks the cap before sending.
 * - A draft that is already `submitted` is never resubmitted: only
 *   drafts with status `approved` are sent, and a submitted draft's
 *   status never goes back.
 * - A market is only re-drafted when fresh research finds findings
 *   not already in the known-facts set. The researcher filters known
 *   facts, so a re-run over unchanged sources finds nothing new and
 *   the pipeline produces no draft. New findings mean new evidence,
 *   which is drafted and submitted up to the per-market cap.
 * - Every submission is recorded in memory (submission plus reward
 *   plus draft status) the moment its receipt arrives, before the
 *   cycle moves to the next market, so an interruption loses no
 *   submitted-evidence records. A later cycle resumes from memory:
 *   it submits approved drafts the interrupted cycle left behind and
 *   works the markets the interrupted cycle never reached.
 *
 * Budgets are guardrails, not errors: when the per-cycle model-call
 * budget runs out, the cycle stops drafting new markets, records
 * that in the report, and finishes normally. Per-market failures
 * (search failure, malformed draft, refusal, rejection) are recorded
 * and the cycle continues with the next market. Only an unexpected
 * error (adapter unreachable, store failure) aborts the cycle, after
 * tracing the error and writing a partial report; the caller sees
 * the original error.
 */

import type { DelphiAdapter } from "../delphi/adapter.js";
import { syncMarkets } from "../delphi/sync.js";
import {
  DraftValidationError,
  runDraftPipeline,
  type DraftSubmitter,
} from "../draft/index.js";
import type { EvidenceDraft } from "../draft/types.js";
import {
  BudgetExhaustedError,
  JsonValidationError,
  ProviderError,
} from "../llm/types.js";
import type { MemoryStore } from "../memory/store.js";
import type { ReadPageFn, ResearcherLimits } from "../research/index.js";
import { SearchError, type SearchProvider } from "../search/types.js";
import {
  createDraftSubmitter,
  ReceiptParseError,
  SubmissionRefusedError,
  SubmissionRejectedError,
  type SubmitDraftDeps,
} from "../submit/index.js";
import { errorMessage } from "../util.js";
import { DEFAULT_CYCLE_TIME_BUDGET_MINUTES } from "../policy/limits.js";
import {
  CountingSearchProvider,
  createModelCallCounter,
  cycleCostPath,
  writeCostRecord,
  type CycleCostRecord,
  type CycleModel,
} from "./costs.js";
import {
  DEFAULT_MAX_MARKETS_PER_CYCLE,
  pickMarkets,
  type MarketSkipReason,
} from "./picking.js";
import {
  cycleReportPath,
  writeCycleReport,
  type CycleDraftInfo,
  type CycleSummary,
} from "./report.js";
import { TraceWriter } from "./trace.js";

export interface CycleDeps {
  /** Memory store: markets, facts, notes, drafts, submissions, rewards. */
  store: MemoryStore;
  /** Delphi adapter: the stub until the live client lands (ticket 08). */
  adapter: DelphiAdapter;
  /** Routed model client, used for extraction, drafting, and judging. */
  model: CycleModel;
  /** Search provider for research. */
  search: SearchProvider;
  /** Page reader for source pages. */
  readPage: ReadPageFn;
  /** Directory for long-term JSON storage, traces, reports, and costs. */
  dataDir: string;
  /**
   * Id of this cycle. Defaults to `cycle-<ISO timestamp>`; pass one
   * explicitly for deterministic runs (tests, ticket 09).
   */
  cycleId?: string;
  /** When true, draft and review without ever submitting. Default false. */
  dryRun?: boolean;
  /** Human approval gate (ADR 0004). Default true: fail closed. */
  approvalGate?: boolean;
  /** Maximum markets worked in this cycle. Default 5. */
  maxMarketsPerCycle?: number;
  /** Maximum submissions sent in this cycle. Default 5. */
  maxSubmissionsPerCycle?: number;
  /**
   * Per-cycle time budget in minutes. The runner stops picking new
   * markets once the deadline passes and finishes normally.
   * Default 45.
   */
  cycleTimeBudgetMinutes?: number;
  /** Self-review pass threshold. Defaults to 0.7. */
  passThreshold?: number;
  /** Bounds for the research loop, per market. */
  researcherLimits?: ResearcherLimits;
  /**
   * Model id sent with Delphi requests. Defaults to the adapter
   * identity's model.
   */
  submissionModel?: string;
  /** Clock seam for timestamps and the default cycle id. */
  now?: () => Date;
  /**
   * Id generator seam for draft ids (and refusal ids). Must return a
   * fresh id on every call: two drafts sharing an id overwrite each
   * other in the store.
   */
  createId?: () => string;
  /** Warning sink for the gate-off warning. Defaults to console.warn. */
  warn?: (message: string) => void;
}

/**
 * Errors that belong to one market only: the cycle records them and
 * continues with the next market. Anything else aborts the cycle.
 */
function isMarketLocalError(error: unknown): boolean {
  return (
    error instanceof SearchError ||
    error instanceof DraftValidationError ||
    error instanceof ReceiptParseError ||
    error instanceof ProviderError ||
    error instanceof JsonValidationError
  );
}

export async function runCycle(deps: CycleDeps): Promise<CycleSummary> {
  const now = deps.now ?? (() => new Date());
  const startedAt = now();
  const cycleId = deps.cycleId ?? `cycle-${startedAt.toISOString()}`;
  const dryRun = deps.dryRun ?? false;
  const approvalGate = deps.approvalGate ?? true;
  const cycleTimeBudgetMinutes =
    deps.cycleTimeBudgetMinutes ?? DEFAULT_CYCLE_TIME_BUDGET_MINUTES;
  const deadlineMs = startedAt.getTime() + cycleTimeBudgetMinutes * 60_000;
  const trace = new TraceWriter(deps.dataDir, cycleId, now);
  const modelCounter = createModelCallCounter(deps.model);
  const searchCounter = new CountingSearchProvider(deps.search);

  const marketsChecked: string[] = [];
  let marketsPicked: string[] = [];
  let marketsSkipped: Array<{
    marketId: string;
    reason: MarketSkipReason;
  }> = [];
  const drafts: CycleDraftInfo[] = [];
  const errors: string[] = [];
  let budgetExhausted = false;
  let timeBudgetExhausted = false;

  trace.write("cycle-start", { detail: { dryRun } });

  /**
   * Build the summary from memory (the source of truth for
   * submissions, refusals, and rewards) plus the drafts and errors
   * observed during the run, then persist the cost record and the
   * report and trace the cycle end.
   */
  const finish = async (
    status: "completed" | "interrupted",
  ): Promise<CycleSummary> => {
    const finishedAt = now().toISOString();
    const submissions = await deps.store.loadSubmissions({ cycleId });
    const refusals = (await deps.store.loadRefusals()).filter(
      (refusal) => refusal.cycleId === cycleId,
    );
    const rewards = await deps.store.loadRewards();
    const judgment = rewards.reduce(
      (sum, reward) => sum + (reward.judgment ?? 0),
      0,
    );
    const settlement = rewards.reduce(
      (sum, reward) => sum + (reward.settlement ?? 0),
      0,
    );
    const cost: CycleCostRecord = {
      cycleId,
      modelCalls: modelCounter.callsUsed(),
      recordedAt: finishedAt,
      searchCalls: searchCounter.searchCalls,
      searchCreditsUsed: searchCounter.searchCreditsUsed,
    };
    const summary: CycleSummary = {
      budgetExhausted,
      cost,
      costPath: cycleCostPath(deps.dataDir, cycleId),
      cycleId,
      drafts,
      dryRun,
      errors,
      finishedAt,
      marketsChecked,
      marketsPicked,
      marketsSkipped,
      refusals: refusals.map((refusal) => ({
        draftId: refusal.draftId,
        marketId: refusal.marketId,
        reason: refusal.reason,
      })),
      reportPath: cycleReportPath(deps.dataDir, cycleId),
      rewardsSoFar: {
        judgment,
        settlement,
        total: judgment + settlement,
      },
      startedAt: startedAt.toISOString(),
      status,
      submissions: submissions.map((submission) => ({
        draftId: submission.draftId,
        marketId: submission.marketId,
        submissionId: submission.id,
        verdict: submission.receipt.verdict,
      })),
      timeBudgetExhausted,
      tracePath: trace.path,
    };
    trace.write("cycle-end", {
      detail: {
        budgetExhausted,
        drafts: drafts.length,
        refusals: refusals.length,
        status,
        submissions: submissions.length,
        timeBudgetExhausted,
      },
    });
    await writeCostRecord(deps.dataDir, cost);
    await writeCycleReport(deps.dataDir, summary);
    return summary;
  };

  try {
    // Sync markets (ticket 03's logic, reused, not copied) and note
    // which ids the store already held, so picking can tell new
    // markets from known ones.
    const beforeIds = new Set(
      (await deps.store.loadMarkets()).map((market) => market.id),
    );
    const sync = await syncMarkets(deps.adapter, deps.store);
    marketsChecked.push(...sync.markets.map((market) => market.id));
    trace.write("market-sync", {
      detail: {
        added: sync.added,
        checked: sync.markets.length,
        updated: sync.updated,
      },
    });

    const allSubmissions = await deps.store.loadSubmissions();
    const submissionsByMarket: Record<string, number> = {};
    for (const submission of allSubmissions) {
      submissionsByMarket[submission.marketId] =
        (submissionsByMarket[submission.marketId] ?? 0) + 1;
    }
    const picked = pickMarkets(sync.markets, {
      maxMarkets: deps.maxMarketsPerCycle ?? DEFAULT_MAX_MARKETS_PER_CYCLE,
      now: now(),
      previouslyStoredIds: beforeIds,
      submissionsByMarket,
    });
    marketsPicked = picked.picked.map((market) => market.id);
    marketsSkipped = picked.skipped.map(({ market, reason }) => ({
      marketId: market.id,
      reason,
    }));
    trace.write("market-pick", {
      detail: {
        picked: marketsPicked,
        skipped: marketsSkipped,
      },
    });

    // The real submitter (ticket 06), wrapped so every attempt, gate
    // decision, receipt, and refusal lands in the trace.
    const submitDeps: SubmitDraftDeps = {
      adapter: deps.adapter,
      approvalGate,
      createId: deps.createId,
      cycleId,
      maxSubmissionsPerCycle: deps.maxSubmissionsPerCycle,
      model: deps.submissionModel ?? deps.adapter.identity.model,
      now,
      store: deps.store,
      warn: deps.warn,
    };
    const realSubmitter = createDraftSubmitter(submitDeps);
    const submitter: DraftSubmitter = async (
      draft: EvidenceDraft,
    ): Promise<void> => {
      let decision: string;
      if (!approvalGate) {
        decision = "allowed:gate-off";
      } else {
        const approval = await deps.store.loadApproval(draft.id);
        decision =
          approval !== undefined
            ? "allowed:human-approved"
            : "refused:gate";
      }
      trace.write("approval-decision", {
        detail: { decision },
        draftId: draft.id,
        marketId: draft.marketId,
      });
      trace.write("submission-attempt", {
        draftId: draft.id,
        marketId: draft.marketId,
      });
      try {
        await realSubmitter(draft);
      } catch (error) {
        if (error instanceof SubmissionRefusedError) {
          trace.write("refusal", {
            detail: { message: error.message, reason: error.reason },
            draftId: draft.id,
            marketId: draft.marketId,
          });
          throw error;
        }
        if (error instanceof SubmissionRejectedError) {
          trace.write("receipt", {
            detail: {
              rationale: error.receipt.rationale,
              verdict: "rejected",
            },
            draftId: draft.id,
            marketId: draft.marketId,
            submissionId: error.receipt.submissionId,
          });
          throw error;
        }
        throw error;
      }
      // The submitter recorded the submission before returning; read
      // it back for the receipt verdict (and any reward).
      const submission = (
        await deps.store.loadSubmissions({ cycleId })
      ).find((candidate) => candidate.draftId === draft.id);
      if (submission === undefined) {
        trace.write("error", {
          detail: {
            message: `No submission record found for draft ${draft.id} after a successful submit.`,
          },
          draftId: draft.id,
          marketId: draft.marketId,
        });
        return;
      }
      trace.write("receipt", {
        detail: {
          verdict: submission.receipt.verdict,
          ...(submission.receipt.reward !== undefined
            ? { reward: submission.receipt.reward }
            : {}),
        },
        draftId: draft.id,
        marketId: draft.marketId,
        submissionId: submission.id,
      });
    };

    for (const market of picked.picked) {
      // Stop drafting new markets when the model-call budget is
      // spent; this is a guardrail doing its job, not a failure.
      const remaining = deps.model.callsRemaining;
      if (remaining !== undefined && remaining <= 0) {
        budgetExhausted = true;
        break;
      }
      // Stop picking new markets once the per-cycle time budget
      // passes; the cycle finishes normally with what it did.
      // The market in progress is never interrupted mid-pipeline.
      if (now().getTime() >= deadlineMs) {
        timeBudgetExhausted = true;
        break;
      }
      trace.write("market-start", { marketId: market.id });
      let outcome = "done";
      // Draft ids already in the store: the pipeline saves a draft
      // before submitting it, so a refused submission still leaves a
      // draft behind. Diffing against this snapshot finds the drafts
      // this market's run created, whatever the outcome was.
      const draftIdsBefore = new Set(
        (await deps.store.loadDrafts(market.id)).map((draft) => draft.id),
      );
      try {
        // Resume: submit approved drafts a previous cycle left
        // behind (gate refusal, crash, or cap) before drafting anew.
        // A refusal or rejection here stops the retries for this
        // market; the pipeline still runs, so new findings can still
        // produce a fresh draft.
        if (!dryRun) {
          const approved = (await deps.store.loadDrafts(market.id)).filter(
            (draft) => draft.status === "approved",
          );
          for (const draft of approved) {
            try {
              await submitter(draft);
            } catch (error) {
              if (
                error instanceof SubmissionRefusedError ||
                error instanceof SubmissionRejectedError
              ) {
                break;
              }
              throw error;
            }
          }
        }

        trace.write("research-start", { marketId: market.id });
        const result = await runDraftPipeline({
          createId: deps.createId,
          dryRun,
          market,
          model: modelCounter.model,
          now,
          passThreshold: deps.passThreshold,
          readPage: deps.readPage,
          researcherLimits: deps.researcherLimits,
          search: searchCounter,
          store: deps.store,
          submit: submitter,
        });
        trace.write("research-end", {
          detail: { findings: result.notes.findings.length },
          marketId: market.id,
        });
        if (result.outcome === "no-draft") {
          trace.write("no-draft", {
            detail: { reason: result.reason },
            marketId: market.id,
          });
        } else {
          trace.write("draft-created", {
            detail: {
              passed: result.draft.score?.passed,
              reviewScore: result.draft.score?.overall,
              submitted: result.submitted,
            },
            draftId: result.draft.id,
            marketId: market.id,
          });
        }
      } catch (error) {
        if (error instanceof BudgetExhaustedError) {
          budgetExhausted = true;
          outcome = "budget-exhausted";
          trace.write("market-end", {
            detail: { outcome },
            marketId: market.id,
          });
          break;
        }
        if (
          error instanceof SubmissionRefusedError ||
          error instanceof SubmissionRejectedError
        ) {
          // Already traced (refusal or receipt) by the submitter
          // wrapper; the draft stays approved for a later cycle.
          outcome =
            error instanceof SubmissionRefusedError ? "refused" : "rejected";
        } else if (isMarketLocalError(error)) {
          const message = errorMessage(error);
          errors.push(`${market.id}: ${message}`);
          trace.write("error", {
            detail: { message },
            marketId: market.id,
          });
          outcome = "error";
        } else {
          throw error;
        }
      } finally {
        // Drafts this market's run created, whatever the outcome:
        // the pipeline saves the draft before submitting, so a
        // refused or rejected submission still counts as a draft.
        // A failed lookup here must not mask the market's outcome.
        try {
          const fresh = (await deps.store.loadDrafts(market.id)).filter(
            (draft) => !draftIdsBefore.has(draft.id),
          );
          for (const draft of fresh) {
            drafts.push({
              draftId: draft.id,
              marketId: market.id,
              reviewPassed: draft.score?.passed,
              reviewScore: draft.score?.overall,
            });
          }
        } catch {
          // Ignored: the summary still reports the market's outcome.
        }
      }
      trace.write("market-end", {
        detail: { outcome },
        marketId: market.id,
      });
    }

    return await finish("completed");
  } catch (error) {
    // Unexpected failure: trace it, write a partial report and cost
    // record when possible, then rethrow the original error. The
    // trace and memory stay intact up to the interruption.
    const message = errorMessage(error);
    errors.push(message);
    trace.write("error", { detail: { message } });
    try {
      await finish("interrupted");
    } catch {
      // A failed report write must not mask the original error.
    }
    throw error;
  }
}
