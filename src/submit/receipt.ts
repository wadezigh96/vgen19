/**
 * Strict receipt parsing: the raw value the Delphi adapter returns
 * is checked field by field before anything trusts it. Unknown or
 * missing fields are a parse error, never silently accepted, so a
 * changed receipt shape fails loudly instead of recording garbage.
 *
 * The receipt shape is Vgen19's own until the official guide is
 * published on 23 November 2026 (ticket 08): if the real API returns
 * extra fields, this parser is the one place that must learn them.
 */

import {
  ReceiptParseError,
  type ReceiptReward,
  type ReceiptVerdict,
  type SubmissionReceipt,
} from "./types.js";

export { ReceiptParseError } from "./types.js";

const RECEIPT_KEYS = new Set([
  "draftId",
  "marketId",
  "rationale",
  "reward",
  "submissionId",
  "submittedAt",
  "verdict",
]);

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
  // TODO(ticket 08): the real receipt format will confirm the currency.
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

/**
 * Parse a raw receipt value into a `SubmissionReceipt`. Throws
 * `ReceiptParseError` naming the first violation when the value is
 * not an object, misses a required field, carries an unknown field,
 * has a verdict outside the union, or carries a malformed reward.
 */
export function parseSubmissionReceipt(value: unknown): SubmissionReceipt {
  if (!isRecord(value)) {
    fail("receipt must be an object.");
  }
  for (const key of Object.keys(value)) {
    if (!RECEIPT_KEYS.has(key)) {
      fail(`unknown receipt field "${key}".`);
    }
  }
  const verdict = requireNonEmptyString(value, "verdict");
  if (!VERDICTS.has(verdict)) {
    fail(
      `"verdict" must be one of "accepted", "rejected", "judged", ` +
        `got "${verdict}".`,
    );
  }
  const receipt: SubmissionReceipt = {
    draftId: requireNonEmptyString(value, "draftId"),
    marketId: requireNonEmptyString(value, "marketId"),
    submissionId: requireNonEmptyString(value, "submissionId"),
    submittedAt: requireValidTimestamp(value, "submittedAt"),
    verdict: verdict as ReceiptVerdict,
  };
  const rationale = value["rationale"];
  if (rationale !== undefined) {
    if (typeof rationale !== "string") {
      fail('"rationale" must be a string.');
    }
    receipt.rationale = rationale;
  }
  if (value["reward"] !== undefined) {
    receipt.reward = parseReward(value["reward"]);
  }
  return receipt;
}
