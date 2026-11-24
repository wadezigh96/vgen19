/**
 * Reward recording: judgment and settlement rewards stay attached to
 * the submission that earned them, keyed by submission id.
 *
 * Judgment rewards arrive with the receipt and are recorded by the
 * submitter — or later, by the outcome sync (`outcomes.ts`, ticket
 * 08), when a submission that was queued at send time gets judged.
 * Settlement rewards arrive later, when the market settles the way
 * the evidence pointed; `recordSettlementReward` records one
 * against its submission. No production caller fetches settlement
 * data yet: the SDK exposes no field for the earned settlement
 * amount (only `settlementUpTo`, the maximum), so settlement data
 * still arrives by hand until the official guide documents where
 * the earned amount appears.
 */

import type { MemoryStore } from "../memory/store.js";
import type { RewardRecord } from "./types.js";

export interface RecordSettlementRewardOptions {
  /** Clock seam for the recorded timestamp. */
  now?: () => Date;
}

/**
 * Add a settlement reward to a submission's reward record and return
 * the updated record. Creates the record when the receipt carried no
 * reward. Throws for an unknown submission id (a reward must attach
 * to a submission that exists) or a negative or non-finite amount.
 */
export async function recordSettlementReward(
  store: MemoryStore,
  submissionId: string,
  amount: number,
  options: RecordSettlementRewardOptions = {},
): Promise<RewardRecord> {
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) {
    throw new Error(
      `Settlement reward must be a non-negative number, got ${amount}.`,
    );
  }
  const submission = await store.loadSubmission(submissionId);
  if (submission === undefined) {
    throw new Error(`Unknown submission: ${submissionId}.`);
  }
  const now = options.now ?? (() => new Date());
  const existing = await store.loadReward(submissionId);
  const updated: RewardRecord = {
    // Keep the currency the submission's reward was recorded in;
    // a new record inherits the receipt's currency when the receipt
    // carried one, else "USDC".
    currency:
      existing?.currency ?? submission.receipt.reward?.currency ?? "USDC",
    draftId: submission.draftId,
    marketId: submission.marketId,
    recordedAt: now().toISOString(),
    settlement: amount,
    submissionId,
    ...(existing?.judgment !== undefined
      ? { judgment: existing.judgment }
      : {}),
  };
  await store.saveReward(updated);
  return updated;
}
