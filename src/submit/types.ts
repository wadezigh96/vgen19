/**
 * Submission domain types: the receipt Delphi returns for a
 * submission, the stored submission record, the human approval
 * record, per-submission rewards, and refused attempts.
 *
 * Vocabulary follows GLOSSARY.md: a submission is one evidence
 * delivery to Delphi for one market (at most 3 per market); a
 * receipt is the verdict, rationale, and reward returned for it;
 * judgment and settlement rewards are recorded against the
 * submission that earned them, never aggregated away.
 */

export {
  DEFAULT_MAX_SUBMISSIONS_PER_CYCLE,
  MAX_SUBMISSIONS_PER_MARKET,
} from "../policy/limits.js";

/** The verdict a receipt carries for a submission. */
export type ReceiptVerdict = "accepted" | "rejected" | "judged";

/**
 * The currency a reward is paid in. The glossary says rewards are
 * paid in USDC.e (the bridged USDC token); "USDC" is accepted too
 * because the stub and early receipts use it. Real receipts
 * (ticket 08) carry "USDC.e": the bounty amount is USDC.e base
 * units — see `src/delphi/evidence.ts`.
 */
export type RewardCurrency = "USDC" | "USDC.e";

/** The reward a receipt carries, in USDC or USDC.e. Either part may be absent. */
export interface ReceiptReward {
  /** Reward fixed when the submission was judged. */
  judgment?: number;
  /** Additional reward when the market settled the way the evidence pointed. */
  settlement?: number;
  /** Rewards are paid in USDC.e; "USDC" is accepted for compatibility. */
  currency: RewardCurrency;
}

/**
 * The receipt Delphi returns for a submission: the verdict, the
 * rationale, and the reward, usually within minutes. Parsed by
 * `parseSubmissionReceipt`: missing or malformed required fields
 * are a parse error, never silently accepted, while extra fields
 * the API returns are tolerated (the SDK says extra keys stay
 * readable on submissions).
 */
export interface SubmissionReceipt {
  /** Id Delphi assigned to the submission. */
  submissionId: string;
  /** Id of the draft that was submitted. */
  draftId: string;
  /** Id of the market the evidence is for. */
  marketId: string;
  /** What Delphi decided about the submission. */
  verdict: ReceiptVerdict;
  /** Why Delphi decided that way, when it says. */
  rationale?: string;
  /** The reward the receipt carries, when it carries one. */
  reward?: ReceiptReward;
  /** ISO timestamp when the submission was accepted by Delphi. */
  submittedAt: string;
}

/**
 * Lifecycle of a stored submission: it mirrors the receipt verdict.
 * `accepted` and `judged` both mean the evidence was sent and kept;
 * `rejected` means Delphi turned it down and the draft stays approved
 * so it may be retried in a later cycle.
 */
export type SubmissionStatus = ReceiptVerdict;

/** One submission, stored in memory with its receipt. */
export interface SubmissionRecord {
  /** Id Delphi assigned to the submission (the receipt's id). */
  id: string;
  /** Id of the draft that was submitted. */
  draftId: string;
  /** Id of the market the evidence is for. */
  marketId: string;
  /** Id of the mining cycle that sent it (or a manual run id). */
  cycleId: string;
  /** The receipt Delphi returned. */
  receipt: SubmissionReceipt;
  /** Mirrors the receipt verdict. */
  status: SubmissionStatus;
  /** ISO timestamp when the record was stored. */
  recordedAt: string;
}

/**
 * A submission in flight: recorded BEFORE the network call, deleted
 * once the submission (or the failure) is recorded. A crash between
 * the adapter call and the memory write leaves this behind, and a
 * resume refuses to send the draft again while it exists — the
 * evidence may already be at Delphi, so a second send would be a
 * duplicate. A transient adapter failure deletes it, so a retry can
 * proceed. Keyed by draft id: one pending submission per draft.
 */
export interface PendingSubmission {
  /** Id of the draft being submitted. */
  draftId: string;
  /** Id of the market the evidence is for. */
  marketId: string;
  /** Id of the mining cycle (or manual run) that sent it. */
  cycleId: string;
  /** ISO timestamp when the pending record was written. */
  recordedAt: string;
}

/**
 * A human approval for one draft: the approval gate (ADR 0004)
 * requires one per draft before it may be sent. Approval is
 * per-draft, not per-market.
 */
export interface Approval {
  /** Id of the draft the human approved. */
  draftId: string;
  /** Approvals come from a human, never from the agent itself. */
  approvedBy: "human";
  /** ISO timestamp when the approval was recorded. */
  approvedAt: string;
  /** Optional note from the human, e.g. why the draft is good. */
  note?: string;
}

/**
 * The rewards one submission earned, keyed by submission id.
 * Judgment rewards arrive with the receipt; settlement rewards
 * arrive later and are added to the same record.
 */
export interface RewardRecord {
  /** Id of the submission that earned the reward. */
  submissionId: string;
  /** Id of the draft that was submitted. */
  draftId: string;
  /** Id of the market the evidence is for. */
  marketId: string;
  /** Reward fixed when the submission was judged. */
  judgment?: number;
  /** Additional reward when the market settled the way the evidence pointed. */
  settlement?: number;
  /** The currency the reward was paid in, as the receipt carried it. */
  currency: RewardCurrency;
  /** ISO timestamp when the record was last updated. */
  recordedAt: string;
}

/** Why a submission attempt was refused. */
export type RefusalReason =
  /** The draft's status was not `approved`. */
  | "not-approved"
  /** The approval gate is on and no approval record exists. */
  | "gate"
  /** The market already has 3 submissions. */
  | "cap-market"
  /** The cycle already sent its maximum submissions. */
  | "cap-cycle"
  /** A previous attempt for this draft is still pending (see `PendingSubmission`). */
  | "pending"
  /** The market's evidence cutoff has passed. */
  | "past-cutoff";

/**
 * A refused submission attempt: recorded so reports can show it,
 * but never counted as a submission (it never reached Delphi).
 */
export interface SubmissionRefusal {
  /** Unique id for this refusal record. */
  id: string;
  /** Id of the draft that was refused. */
  draftId: string;
  /** Id of the market the draft is for. */
  marketId: string;
  /** Id of the mining cycle (or manual run) that attempted it. */
  cycleId: string;
  /** The machine-readable reason for the refusal. */
  reason: RefusalReason;
  /** The human-readable refusal message. */
  message: string;
  /** ISO timestamp when the refusal was recorded. */
  refusedAt: string;
}

/** A receipt failed strict parsing; the message names the violation. */
export class ReceiptParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReceiptParseError";
  }
}

/**
 * A submission attempt was refused before anything was sent. The
 * `reason` names the policy that refused it; the message explains it
 * in words. The attempt is recorded as a refusal, not a submission.
 */
export class SubmissionRefusedError extends Error {
  readonly reason: RefusalReason;

  constructor(reason: RefusalReason, message: string) {
    super(message);
    this.name = "SubmissionRefusedError";
    this.reason = reason;
  }
}

/**
 * Delphi received the submission but rejected it. The receipt (with
 * its rationale) is carried on the error so callers can report it.
 * The draft stays approved: it may be retried in a later cycle.
 */
export class SubmissionRejectedError extends Error {
  readonly receipt: SubmissionReceipt;

  constructor(receipt: SubmissionReceipt) {
    super(
      `Delphi rejected the submission of draft ${receipt.draftId}` +
        (receipt.rationale !== undefined
          ? `: ${receipt.rationale}`
          : "."),
    );
    this.name = "SubmissionRejectedError";
    this.receipt = receipt;
  }
}
