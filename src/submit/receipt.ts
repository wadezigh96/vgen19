/**
 * Receipt parsing: the raw value the Delphi adapter returns is
 * checked field by field before anything trusts it. Missing or
 * malformed required fields are a parse error, never silently
 * accepted, so a changed receipt shape fails loudly instead of
 * recording garbage.
 *
 * Two shapes are accepted (ticket 08):
 *
 * - The Vgen19 receipt shape (`submissionId`, `draftId`,
 *   `marketId`, `verdict`, `submittedAt`, optional `rationale` and
 *   `reward`): what the stub and the test fakes return.
 * - The real Delphi `Submission` shape (`id`, `createdAt`,
 *   `status`, `markets[]`): what the evidence API returns. The
 *   parser needs draft and market context for this shape, because
 *   a submission carries no draft id — the caller passes the draft
 *   it submitted, and the parser verifies the submission's market
 *   list actually contains that market.
 *
 * Extra fields are TOLERATED on both shapes: the SDK says extra
 * keys stay readable on submissions, so the parser ignores fields
 * it does not know instead of rejecting the whole receipt. The
 * reward object stays strict — it is Vgen19's own shape, and an
 * unknown reward field is still a parse error.
 *
 * Bounty units: a judged submission's bounty `amount` is read as
 * USDC.e base units (6 decimals) — see the note in
 * `src/delphi/evidence.ts`.
 */

import { baseUnitsToUsdcE } from "../delphi/evidence.js";
import { errorMessage } from "../util.js";
import {
  ReceiptParseError,
  type ReceiptReward,
  type ReceiptVerdict,
  type SubmissionReceipt,
} from "./types.js";

export { ReceiptParseError } from "./types.js";

const REWARD_KEYS = new Set(["currency", "judgment", "settlement"]);

const VERDICTS: ReadonlySet<string> = new Set([
  "accepted",
  "rejected",
  "judged",
]);

const CURRENCIES: ReadonlySet<string> = new Set(["USDC", "USDC.e"]);

function fail(violation: string): never {
  throw new ReceiptParseError(`Receipt parse failed: ${violation}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireNonEmptyString(
  record: Record<string, unknown>,
  field: string,
): string {
  const value = record[field];
  if (typeof value !== "string" || value.trim() === "") {
    fail(`"${field}" must be a non-empty string.`);
  }
  return value;
}

function requireValidTimestamp(
  record: Record<string, unknown>,
  field: string,
): string {
  const value = requireNonEmptyString(record, field);
  if (Number.isNaN(Date.parse(value))) {
    fail(`"${field}" must be a valid ISO timestamp, got "${value}".`);
  }
  return value;
}

function parseReward(value: unknown): ReceiptReward {
  if (!isRecord(value)) {
    fail('"reward" must be an object.');
  }
  for (const key of Object.keys(value)) {
    if (!REWARD_KEYS.has(key)) {
      fail(`unknown reward field "${key}".`);
    }
  }
  // Both "USDC" and "USDC.e" parse: the glossary says rewards are
  // paid in USDC.e, and the stub and early receipts say "USDC".
  // Real receipts (ticket 08) carry "USDC.e" — see `parseBounty`.
  if (
    typeof value["currency"] !== "string" ||
    !CURRENCIES.has(value["currency"])
  ) {
    fail('"reward.currency" must be "USDC" or "USDC.e".');
  }
  const reward: ReceiptReward = {
    currency: value["currency"] as ReceiptReward["currency"],
  };
  for (const part of ["judgment", "settlement"] as const) {
    const amount = value[part];
    if (amount === undefined) {
      continue;
    }
    if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) {
      fail(`"reward.${part}" must be a non-negative number.`);
    }
    reward[part] = amount;
  }
  return reward;
}

function parseVgen19Receipt(
  record: Record<string, unknown>,
): SubmissionReceipt {
  const verdict = requireNonEmptyString(record, "verdict");
  if (!VERDICTS.has(verdict)) {
    fail(
      `"verdict" must be one of "accepted", "rejected", "judged", ` +
        `got "${verdict}".`,
    );
  }
  const receipt: SubmissionReceipt = {
    draftId: requireNonEmptyString(record, "draftId"),
    marketId: requireNonEmptyString(record, "marketId"),
    submissionId: requireNonEmptyString(record, "submissionId"),
    submittedAt: requireValidTimestamp(record, "submittedAt"),
    verdict: verdict as ReceiptVerdict,
  };
  const rationale = record["rationale"];
  if (rationale !== undefined) {
    if (typeof rationale !== "string") {
      fail('"rationale" must be a string.');
    }
    receipt.rationale = rationale;
  }
  if (record["reward"] !== undefined) {
    receipt.reward = parseReward(record["reward"]);
  }
  return receipt;
}

/**
 * Map a Delphi submission status onto a receipt verdict. `queued`
 * and `judging` both mean Delphi took the evidence and has not
 * decided yet, so they map to `accepted` — the outcome sync
 * refreshes them once Delphi judges. `failed` and `unmatched` are
 * terminal without a judgment, so they map to `rejected` like a
 * rejection does.
 */
function submissionStatusToVerdict(status: unknown): ReceiptVerdict {
  switch (status) {
    case "judged":
      return "judged";
    case "rejected":
    case "failed":
    case "unmatched":
      return "rejected";
    case "queued":
    case "judging":
      return "accepted";
    default:
      fail(`unknown Delphi submission status: ${String(status)}.`);
  }
}

/**
 * Map a submission market entry's bounty onto a receipt reward.
 * `none` and `voided` mean no reward was earned; `held` and `paid`
 * carry the judgment reward in USDC.e base units. A malformed
 * amount fails loudly: a reward must never be silently dropped.
 */
function parseBounty(value: unknown): ReceiptReward | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    fail('"bounty" must be an object or null.');
  }
  const state = value["state"];
  if (state === "none" || state === "voided") {
    return undefined;
  }
  if (state !== "held" && state !== "paid") {
    fail(`unknown bounty state: ${String(state)}.`);
  }
  const amount = value["amount"];
  if (typeof amount !== "string") {
    fail('"bounty.amount" must be a string in USDC.e base units.');
  }
  try {
    return { currency: "USDC.e", judgment: baseUnitsToUsdcE(amount) };
  } catch (error) {
    fail(errorMessage(error));
  }
}

function parseDelphiSubmission(
  record: Record<string, unknown>,
  context: ReceiptContext | undefined,
): SubmissionReceipt {
  if (context === undefined) {
    fail(
      "a Delphi submission receipt needs draft and market context: " +
        "the submission itself carries no draft id.",
    );
  }
  const submissionId = requireNonEmptyString(record, "id");
  const submittedAt = requireValidTimestamp(record, "createdAt");
  const verdict = submissionStatusToVerdict(record["status"]);
  const markets = record["markets"];
  if (!Array.isArray(markets) || markets.length === 0) {
    fail(`submission ${submissionId} has no market entries.`);
  }
  const entry = markets.find((candidate) => {
    if (!isRecord(candidate)) {
      return false;
    }
    const address = candidate["marketAddress"];
    return (
      typeof address === "string" &&
      address.toLowerCase() === context.marketId.toLowerCase()
    );
  });
  if (entry === undefined || !isRecord(entry)) {
    fail(
      `submission ${submissionId} has no market entry for ${context.marketId}.`,
    );
  }
  const reason = entry["reason"];
  const code = record["code"];
  const zeroPayReason = entry["zeroPayReason"];
  let rationale: string | undefined;
  if (typeof reason === "string" && reason !== "") {
    rationale = reason;
  } else if (typeof code === "string" && code !== "") {
    rationale = code;
  } else if (
    typeof zeroPayReason === "string" &&
    zeroPayReason !== ""
  ) {
    rationale = `Zero payment: ${zeroPayReason}.`;
  }
  const reward = parseBounty(entry["bounty"]);
  return {
    ...(rationale !== undefined ? { rationale } : {}),
    ...(reward !== undefined ? { reward } : {}),
    draftId: context.draftId,
    marketId: context.marketId,
    submissionId,
    submittedAt,
    verdict,
  };
}

/**
 * The draft and market a receipt belongs to. Required when the raw
 * value is a real Delphi submission (it carries no draft id);
 * ignored for the Vgen19 receipt shape (it carries both ids, and
 * the submitter checks them against the draft).
 */
export interface ReceiptContext {
  draftId: string;
  marketId: string;
}

/**
 * Parse a raw receipt value into a `SubmissionReceipt`. Accepts
 * both the Vgen19 receipt shape and the real Delphi `Submission`
 * shape; extra fields are tolerated on both. Throws
 * `ReceiptParseError` naming the first violation when the value is
 * not an object, misses a required field, has a verdict or status
 * outside the known unions, carries a malformed reward, or (for a
 * real submission) has no market entry for the submitted market.
 */
export function parseSubmissionReceipt(
  value: unknown,
  context?: ReceiptContext,
): SubmissionReceipt {
  if (!isRecord(value)) {
    fail("receipt must be an object.");
  }
  if (typeof value["submissionId"] === "string") {
    return parseVgen19Receipt(value);
  }
  if (
    typeof value["id"] === "string" &&
    typeof value["status"] === "string" &&
    Array.isArray(value["markets"])
  ) {
    return parseDelphiSubmission(value, context);
  }
  fail(
    "receipt is neither the Vgen19 receipt shape nor a Delphi " +
      "submission: it has neither `submissionId` nor " +
      "(`id`, `status`, `markets`).",
  );
}
