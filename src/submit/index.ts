/**
 * Submit module: sends approved drafts to Delphi, parses receipts,
 * enforces the human approval gate and the submission caps, and
 * records rewards per submission.
 *
 * Until the live Delphi client lands (ticket 08), the adapter stub
 * answers with a canned receipt; the submitter, the gate, the caps,
 * and the recording all work the same against the stub.
 */

export { approveDraft, type ApproveDraftOptions } from "./approvals.js";
export {
  parseSubmissionReceipt,
  ReceiptParseError,
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
