/**
 * The submitter: sends approved drafts to Delphi and records what
 * comes back.
 *
 * This is the function that fills ticket 05's `DraftSubmitter` seam:
 * `createDraftSubmitter` binds the dependencies and returns a
 * `(draft) => Promise<void>` the draft pipeline can call. The
 * pipeline only calls it for an approved draft outside dry-run mode;
 * the submitter still re-checks every guard itself, because it is
 * the last gate before anything leaves the agent.
 *
 * Order of work: validate the draft shape, refuse anything that is
 * not approved, resolve from an existing submission for this draft
 * (a crash left it recorded but the draft approved), refuse while a
 * pending submission exists for the draft (a crash left the send
 * unresolved), enforce the human approval gate (ADR 0004, fail
 * closed), refuse past the market's evidence cutoff, enforce the
 * per-market and per-cycle caps, record a pending submission, send
 * through the adapter, parse the receipt strictly, record the
 * submission and any reward, record the submitted facts as known,
 * and mark the draft submitted only when the receipt says the
 * evidence was accepted (or already judged).
 *
 * Crash safety: the pending record is written BEFORE the network
 * call and deleted only after the submission is recorded (or after a
 * transient adapter failure, which is retryable). A crash between
 * the adapter call and the memory write therefore leaves the pending
 * record behind, and the next attempt refuses instead of sending a
 * duplicate. A crash after the submission was recorded but before
 * the draft was marked submitted resolves from the stored record
 * without calling the adapter again.
 */

import { randomUUID } from "node:crypto";

import { AGENT_NAME, HARNESS } from "../agent.js";
import type { DelphiAdapter } from "../delphi/adapter.js";
import type { DraftSubmitter } from "../draft/pipeline.js";
import type { EvidenceDraft } from "../draft/types.js";
import { validateDraft } from "../draft/validate.js";
import type { MemoryStore } from "../memory/store.js";
import { pastEvidenceCutoff } from "../policy/limits.js";
import {
  normalizeClaim,
  type KnownFact,
} from "../research/notes.js";
import { parseSubmissionReceipt } from "./receipt.js";
import {
  DEFAULT_MAX_SUBMISSIONS_PER_CYCLE,
  MAX_SUBMISSIONS_PER_MARKET,
  ReceiptParseError,
  SubmissionRefusedError,
  SubmissionRejectedError,
  type RefusalReason,
  type SubmissionReceipt,
  type SubmissionRecord,
} from "./types.js";

export interface SubmitDraftDeps {
  /** Memory store: drafts, approvals, submissions, rewards, refusals. */
  store: MemoryStore;
  /** Delphi adapter: the live client when a key is configured, the stub otherwise. */
  adapter: DelphiAdapter;
  /**
   * Id of the mining cycle sending this draft (ticket 07 owns
   * cycles); the CLI passes a `manual-<timestamp>` id. The per-cycle
   * cap counts submissions with this id.
   */
  cycleId: string;
  /** Model id used to draft the evidence, sent with the request. */
  model: string;
  /**
   * Human approval gate (ADR 0004, config `VGEN19_APPROVAL_GATE`).
   * Default true: fail closed. When on, the draft must carry an
   * approval record; when off, submissions proceed with a warning.
   */
  approvalGate?: boolean;
  /**
   * Maximum submissions in one cycle (config
   * `VGEN19_MAX_SUBMISSIONS_PER_CYCLE`). Default 5.
   */
  maxSubmissionsPerCycle?: number;
  /** Clock seam for recorded timestamps. */
  now?: () => Date;
  /** Id generator seam for refusal records. */
  createId?: () => string;
  /** Warning sink for the gate-off warning. Defaults to console.warn. */
  warn?: (message: string) => void;
}

/** What `submitDraft` returns: the stored submission and its receipt. */
export interface SubmitDraftResult {
  /** The submission record, stored in memory. */
  submission: SubmissionRecord;
  /** The parsed receipt Delphi returned. */
  receipt: SubmissionReceipt;
}

/**
 * Submit one draft to Delphi. Returns the stored submission and its
 * receipt. Throws `SubmissionRefusedError` when the draft may not be
 * sent (not approved, gate on without approval, cap reached, a
 * previous attempt still pending, or the evidence cutoff passed);
 * the refusal is recorded in memory and nothing is sent. Throws
 * `ReceiptParseError` when the receipt is malformed or names a
 * different draft or market; the draft stays approved.
 *
 * A receipt with verdict `rejected` is NOT an error here: the
 * submission is recorded as rejected with the rationale and the
 * draft stays approved, so it may be retried in a later cycle. The
 * `DraftSubmitter` seam adapter (`createDraftSubmitter`) turns that
 * into a `SubmissionRejectedError` instead, so the draft pipeline
 * does not mark the draft submitted.
 *
 * Idempotency: when a submission for this draft is already recorded
 * with an accepted or judged verdict (a crash left the draft
 * approved after the record was written), the stored submission and
 * receipt are returned without calling the adapter again, and the
 * draft is marked submitted. A rejected record allows a retry.
 */
export async function submitDraft(
  draft: EvidenceDraft,
  deps: SubmitDraftDeps,
): Promise<SubmitDraftResult> {
  const now = deps.now ?? (() => new Date());
  const createId = deps.createId ?? (() => randomUUID());
  const warn = deps.warn ?? ((message: string) => console.warn(message));
  const approvalGate = deps.approvalGate ?? true;
  const maxSubmissionsPerCycle =
    deps.maxSubmissionsPerCycle ?? DEFAULT_MAX_SUBMISSIONS_PER_CYCLE;

  // Strict shape first (spec story 24): malformed output never leaves
  // the agent, whatever the draft's status says.
  validateDraft(draft);

  const refuse = async (
    reason: RefusalReason,
    message: string,
  ): Promise<never> => {
    await deps.store.recordRefusal({
      cycleId: deps.cycleId,
      draftId: draft.id,
      id: createId(),
      marketId: draft.marketId,
      message,
      reason,
      refusedAt: now().toISOString(),
    });
    throw new SubmissionRefusedError(reason, message);
  };

  // Only approved drafts are sent; the message names the status.
  if (draft.status !== "approved") {
    await refuse(
      "not-approved",
      `Draft ${draft.id} cannot be submitted: its status is ` +
        `"${draft.status}", not "approved".`,
    );
  }

  // Crash recovery, part 1: a submission already recorded for this
  // draft with an accepted or judged verdict means the evidence
  // reached Delphi and only the draft-status write was lost. Resolve
  // from the stored record instead of sending a duplicate. This runs
  // BEFORE the cap checks, because the draft's own submission would
  // otherwise trip them. A rejected record allows a retry.
  const priorSubmissions = await deps.store.loadSubmissions({
    draftId: draft.id,
  });
  const recorded = priorSubmissions.find(
    (submission) =>
      submission.status === "accepted" || submission.status === "judged",
  );
  if (recorded !== undefined) {
    draft.status = "submitted";
    await deps.store.saveDraft(draft);
    return { receipt: recorded.receipt, submission: recorded };
  }

  // Crash recovery, part 2: a pending record means a previous
  // attempt may already have reached Delphi (the crash window
  // between the adapter call and the memory write). Refuse rather
  // than risk a duplicate; an operator clears the pending record
  // once Delphi confirms what happened.
  const pending = await deps.store.loadPendingSubmission(draft.id);
  if (pending !== undefined) {
    await refuse(
      "pending",
      `Draft ${draft.id} cannot be submitted: a previous submission ` +
        `attempt is still pending (recorded ${pending.recordedAt}). ` +
        `The evidence may already be at Delphi; check before retrying.`,
    );
  }

  // The approval gate (ADR 0004): when enabled, the draft must carry
  // a human approval record. Fail closed: no record, no submission.
  if (approvalGate) {
    const approval = await deps.store.loadApproval(draft.id);
    if (approval === undefined) {
      await refuse(
        "gate",
        `Draft ${draft.id} cannot be submitted: the approval gate is on ` +
          `and no human approval exists for it. ` +
          `Run \`vgen19 approve ${draft.id}\` first.`,
      );
    }
  } else {
    warn(
      `Warning: the approval gate is OFF; submitting draft ${draft.id} ` +
        `without human approval.`,
    );
  }

  // The evidence cutoff (backstop; picking already skips past-cutoff
  // markets): evidence for a market past its cutoff does not count.
  // When the market is absent from the store, there is nothing to
  // check against, so the submission proceeds (fail open, documented).
  const markets = await deps.store.loadMarkets();
  const market = markets.find((candidate) => candidate.id === draft.marketId);
  if (
    market !== undefined &&
    pastEvidenceCutoff(market.competition?.evidenceCutoff, now())
  ) {
    await refuse(
      "past-cutoff",
      `Draft ${draft.id} cannot be submitted: market ${draft.marketId} ` +
        `passed its evidence cutoff (${market.competition?.evidenceCutoff}).`,
    );
  }

  // The per-market cap (competition rule: at most 3 submissions per
  // market). Every prior submission counts, including rejected ones:
  // they reached Delphi. Refused attempts never count.
  const marketSubmissions = await deps.store.loadSubmissions({
    marketId: draft.marketId,
  });
  if (marketSubmissions.length >= MAX_SUBMISSIONS_PER_MARKET) {
    await refuse(
      "cap-market",
      `Draft ${draft.id} cannot be submitted: market ${draft.marketId} ` +
        `already has ${MAX_SUBMISSIONS_PER_MARKET} submissions (the ` +
        `per-market cap).`,
    );
  }

  // The per-cycle cap: submissions already sent in this cycle.
  const cycleSubmissions = await deps.store.loadSubmissions({
    cycleId: deps.cycleId,
  });
  if (cycleSubmissions.length >= maxSubmissionsPerCycle) {
    await refuse(
      "cap-cycle",
      `Draft ${draft.id} cannot be submitted: cycle ${deps.cycleId} ` +
        `already sent ${maxSubmissionsPerCycle} submissions (the ` +
        `per-cycle cap).`,
    );
  }

  // Record the pending submission BEFORE the network call: if the
  // process dies between the adapter call and the memory write, the
  // pending record is what stops the next attempt from duplicating.
  const recordedAt = now().toISOString();
  await deps.store.savePendingSubmission({
    cycleId: deps.cycleId,
    draftId: draft.id,
    marketId: draft.marketId,
    recordedAt,
  });

  let receipt: SubmissionReceipt;
  try {
    const rawReceipt = await deps.adapter.submitEvidence(draft, {
      agentName: AGENT_NAME,
      harness: HARNESS,
      model: deps.model,
    });
    // The context lets the parser accept the real Delphi
    // `Submission` shape, which carries no draft id: it verifies
    // the submission's market list contains the submitted market.
    receipt = parseSubmissionReceipt(rawReceipt, {
      draftId: draft.id,
      marketId: draft.marketId,
    });
    if (receipt.draftId !== draft.id || receipt.marketId !== draft.marketId) {
      throw new ReceiptParseError(
        `Receipt parse failed: the receipt names draft ${receipt.draftId} ` +
          `for market ${receipt.marketId}, but draft ${draft.id} for market ` +
          `${draft.marketId} was submitted.`,
      );
    }
  } catch (error) {
    // A transient failure (adapter error, malformed receipt) is
    // retryable: clear the pending record so the next attempt can
    // proceed. Only a crash between the adapter call and the memory
    // write leaves the pending record behind.
    await deps.store.deletePendingSubmission(draft.id);
    throw error;
  }

  const submission: SubmissionRecord = {
    cycleId: deps.cycleId,
    draftId: draft.id,
    id: receipt.submissionId,
    marketId: draft.marketId,
    receipt,
    recordedAt,
    status: receipt.verdict,
  };
  await deps.store.saveSubmission(submission);
  // The submission is recorded, so the send is no longer pending:
  // a later crash resolves from the stored record instead.
  await deps.store.deletePendingSubmission(draft.id);

  if (receipt.reward !== undefined) {
    await deps.store.saveReward({
      currency: receipt.reward.currency,
      draftId: draft.id,
      judgment: receipt.reward.judgment,
      marketId: draft.marketId,
      recordedAt,
      settlement: receipt.reward.settlement,
      submissionId: receipt.submissionId,
    });
  }

  // Known facts are recorded at submit time, from the findings the
  // draft actually cited — never at research time, where a draft
  // that fails review would burn its evidence. Recorded for every
  // verdict: the facts reached Delphi even when Delphi rejected
  // them. When no research notes are stored for the market, there
  // is nothing to record.
  const notes = await deps.store.loadResearchNotes(draft.marketId);
  if (notes !== undefined) {
    const citedUrls = new Set(draft.links.map((link) => link.url));
    const submittedFacts: KnownFact[] = notes.findings
      .filter((finding) => citedUrls.has(finding.sourceUrl))
      .map((finding) => ({
        claim: finding.claim,
        date: finding.date,
        normalizedClaim: normalizeClaim(finding.claim),
        recordedAt,
        sourceUrl: finding.sourceUrl,
      }));
    if (submittedFacts.length > 0) {
      await deps.store.addKnownFacts(draft.marketId, submittedFacts);
    }
  }

  // Only an accepted (or already judged) receipt marks the draft
  // submitted. A rejected receipt leaves it approved for a retry.
  if (receipt.verdict === "accepted" || receipt.verdict === "judged") {
    draft.status = "submitted";
    await deps.store.saveDraft(draft);
  }

  return { receipt, submission };
}

/**
 * Bind `submitDraft` into ticket 05's `DraftSubmitter` seam. The
 * pipeline marks the draft submitted after this resolves, so a
 * rejected receipt throws `SubmissionRejectedError` (carrying the
 * receipt) instead of resolving: the draft stays approved and the
 * rejection is visible to the caller.
 */
export function createDraftSubmitter(deps: SubmitDraftDeps): DraftSubmitter {
  return async (draft: EvidenceDraft): Promise<void> => {
    const { receipt } = await submitDraft(draft, deps);
    if (receipt.verdict === "rejected") {
      throw new SubmissionRejectedError(receipt);
    }
  };
}
