/**
 * Submission outcome sync (ticket 08, the P2 settlement fetch):
 * refresh the stored submissions that were still awaiting judgment
 * when they were sent.
 *
 * The evidence API answers a submit with a `queued` submission and
 * judges it later, so the receipt at submit time carries verdict
 * `accepted` and no reward. This sync re-reads every stored
 * submission in status `accepted` through `getSubmission` and,
 * once Delphi judges it, updates the stored record (receipt and
 * status) and records the judgment reward the bounty carries.
 * Submissions already `judged` or `rejected` are terminal and are
 * never re-checked.
 *
 * What this sync does NOT do: the settlement reward. The
 * `Submission` shape carries `settlementUpTo` — the MAXIMUM
 * settlement reward, not an earned amount — and no field for the
 * settlement reward actually paid. There is no verifiable API
 * field for it in the SDK, so this sync leaves the settlement
 * part alone (an existing settlement reward is preserved, never
 * overwritten) and `recordSettlementReward` stays the manual path
 * for settlement data until the official guide documents where
 * the earned settlement amount appears.
 *
 * One submission's failure (network error, unparseable response)
 * is recorded in the result and never stops the rest: a refresh
 * must not abort a mining cycle, and a failed refresh is retried
 * on the next cycle.
 *
 * A submission rejected after the fact leaves its draft
 * `submitted`: the evidence did reach Delphi, its facts are
 * recorded as known, and a later cycle drafts fresh evidence
 * rather than resending the same draft. The draft status never
 * goes back (see the runner's idempotency notes).
 */

import type { MemoryStore } from "../memory/store.js";
import { errorMessage } from "../util.js";
import { parseSubmissionReceipt } from "./receipt.js";
import type { SubmissionRecord } from "./types.js";

export interface SubmissionOutcomeFailure {
  /** Id Delphi assigned to the submission. */
  submissionId: string;
  /** Why the refresh failed, in words. */
  message: string;
}

export interface SubmissionOutcomeSyncResult {
  /** Stored submissions in status `accepted` that were checked. */
  checked: number;
  /** Checked submissions whose verdict changed (judged or rejected). */
  updated: number;
  /** Checked submissions still awaiting judgment. */
  unchanged: number;
  /** Checked submissions whose refresh failed. */
  failed: SubmissionOutcomeFailure[];
}

export interface SyncSubmissionOutcomesOptions {
  /** Clock seam for the recorded timestamp. */
  now?: () => Date;
}

/**
 * Refresh every stored submission still awaiting judgment through
 * `getSubmission` (the live client's `GET /submissions/:id`). The
 * caller supplies the function so the stub — which has no
 * `getSubmission` — simply never calls this.
 */
export async function syncSubmissionOutcomes(
  store: MemoryStore,
  getSubmission: (submissionId: string) => Promise<unknown>,
  options: SyncSubmissionOutcomesOptions = {},
): Promise<SubmissionOutcomeSyncResult> {
  const now = options.now ?? (() => new Date());
  const result: SubmissionOutcomeSyncResult = {
    checked: 0,
    failed: [],
    unchanged: 0,
    updated: 0,
  };
  const submissions = await store.loadSubmissions();
  const awaiting = submissions.filter(
    (submission) => submission.status === "accepted",
  );
  for (const submission of awaiting) {
    result.checked += 1;
    try {
      const raw = await getSubmission(submission.id);
      const receipt = parseSubmissionReceipt(raw, {
        draftId: submission.draftId,
        marketId: submission.marketId,
      });
      if (receipt.verdict === "accepted") {
        result.unchanged += 1;
        continue;
      }
      const updated: SubmissionRecord = {
        ...submission,
        receipt,
        status: receipt.verdict,
      };
      await store.saveSubmission(updated);
      if (receipt.reward !== undefined) {
        const existing = await store.loadReward(submission.id);
        await store.saveReward({
          currency: receipt.reward.currency,
          draftId: submission.draftId,
          judgment: receipt.reward.judgment,
          marketId: submission.marketId,
          recordedAt: now().toISOString(),
          ...(existing?.settlement !== undefined
            ? { settlement: existing.settlement }
            : {}),
          ...(receipt.reward.settlement !== undefined
            ? { settlement: receipt.reward.settlement }
            : {}),
          submissionId: submission.id,
        });
      }
      result.updated += 1;
    } catch (error) {
      result.failed.push({
        message: errorMessage(error),
        submissionId: submission.id,
      });
    }
  }
  return result;
}
