/**
 * Submit module: sends approved drafts to Delphi, parses receipts,
 * enforces the human approval gate and the submission caps, and
 * records rewards per submission.
 *
 * The live client (ticket 08) sends real evidence to the evidence
 * API; the adapter stub answers with a canned receipt. The
 * submitter, the gate, the caps, and the recording all work the
 * same against both.
 */

export { approveDraft, type ApproveDraftOptions } from "./approvals.js";
export {
  syncSubmissionOutcomes,
  type SubmissionOutcomeFailure,
  type SubmissionOutcomeSyncResult,
  type SyncSubmissionOutcomesOptions,
} from "./outcomes.js";
export {
  parseSubmissionReceipt,
  ReceiptParseError,
  type ReceiptContext,
} from "./receipt.js";
export {
  recordSettlementReward,
  type RecordSettlementRewardOptions,
} from "./rewards.js";
export {
  createDraftSubmitter,
  submitDraft,
  type SubmitDraftDeps,
  type SubmitDraftResult,
} from "./submitter.js";
export {
  DEFAULT_MAX_SUBMISSIONS_PER_CYCLE,
  MAX_SUBMISSIONS_PER_MARKET,
  SubmissionRefusedError,
  SubmissionRejectedError,
  type Approval,
  type PendingSubmission,
  type ReceiptReward,
  type ReceiptVerdict,
  type RefusalReason,
  type RewardCurrency,
  type RewardRecord,
  type SubmissionReceipt,
  type SubmissionRecord,
  type SubmissionRefusal,
  type SubmissionStatus,
} from "./types.js";
