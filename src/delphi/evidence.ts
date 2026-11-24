/**
 * Evidence API types and errors, taken from the official Delphi SDK
 * (gensyn-ai/gensyn-delphi-sdk, `src/client/evidence.ts`). Nothing
 * here is invented: every field, endpoint path, and error code comes
 * from that source. The live client in `live.ts` uses these; the
 * receipt parser in `src/submit/receipt.ts` maps a `Submission`
 * onto a `SubmissionReceipt`.
 *
 * Bounty units: the SDK documents
 * `judgementPotRemainingBaseUnits` as "USDC.e base units" and says
 * USDC has 6 decimals. The bounty `amount` on a submission is not
 * documented with units anywhere in the SDK, but it is the same
 * pot's money, so `baseUnitsToUsdcE` reads it as USDC.e base units
 * (6 decimals) too. That assumption is stated here and in the
 * README; if the official guide says otherwise at the opening,
 * this is the one place to change.
 */

/** Lifecycle of a submission on the evidence API. */
export type SubmissionStatus =
  | "queued"
  | "judging"
  | "judged"
  | "rejected"
  | "failed"
  | "unmatched";

/** Terminal statuses: no further judging will happen. */
export const TERMINAL_SUBMISSION_STATUSES: readonly SubmissionStatus[] = [
  "judged",
  "rejected",
  "failed",
  "unmatched",
];

/** One market entry on a submission. */
export interface SubmissionMarket {
  marketAddress: string;
  status: string;
  verdict: string | null;
  reason: string | null;
  /** An accepted submission with a reward of 0 has state `none`; `zeroPayReason` says why. */
  bounty: { amount: string; state: "held" | "paid" | "voided" | "none" } | null;
  settlementUpTo: string | null;
  /** Why an accepted submission paid 0. `below_minimum` still counts for the settlement score. */
  zeroPayReason?: "daily_cap" | "pot_empty" | "below_minimum";
}

/** A submission as the evidence API returns it. */
export interface Submission {
  id: string;
  createdAt: string;
  /** `X-Agent-Id` of the submitting call. */
  agentId: string | null;
  /** The account's own content of the submission. */
  note: string | null;
  links: string[];
  files: { name: string | null; contentType: string; sizeBytes: number }[];
  status: SubmissionStatus;
  code?: string;
  canRetry?: boolean;
  retryAt?: string;
  judgingEstimateSeconds?: number;
  markets: SubmissionMarket[];
}

/** List entries are full submissions; extra keys stay readable as in 2.3.0. */
export type SubmissionSummary = Submission & Record<string, unknown>;

/** What `GET /markets/:market/entry-state` returns. */
export interface EntryState {
  canSubmit: boolean;
  reason?: string;
  remainingOnMarket: number;
  /** USDC.e base units left in the market's judgement pot. Information only: an empty pot pays 0 but does not block. */
  judgementPotRemainingBaseUnits: string;
  restricted?: boolean;
  rateLimit: { resetAt: string };
}

/** What `GET /limits` returns. */
export interface EvidenceLimits {
  submitsLeftThisHour: number;
  hourEndsAt: string;
  dailyCapLeft: number;
  dailyCapResetAt: string;
}

/** `GET /terms`: the current terms for the account. `acceptedAt` is `null` until the account accepts this version. */
export interface EvidenceTerms {
  version: string;
  url: string;
  acceptedAt: string | null;
}

/** `POST /terms/acceptance`: the stored acceptance (the first one again if already accepted). */
export interface TermsAcceptance {
  version: string;
  acceptedAt: string;
}

/** Response metadata read from headers. */
export interface EvidenceMeta {
  requestId?: string;
  contractVersion?: string;
  rateLimit?: { limit: number; remaining: number; reset: number };
  /** `X-Delphi-Warnings`, e.g. `missing X-Agent-Id`. */
  warnings?: string;
  /** `Retry-After` in seconds, present while a submission is queued or judging. */
  retryAfterSeconds?: number;
  location?: string;
}

/** A parsed evidence response plus its header metadata. */
export interface EvidenceResult<T> {
  data: T;
  meta: EvidenceMeta;
}

export type EvidenceErrorCode =
  | "invalid_request"
  | "unauthorized"
  | "terms_not_accepted"
  | "forbidden"
  | "not_found"
  | "market_not_found"
  | "idempotency_conflict"
  | "rate_limited"
  | "cap_reached"
  | "server_error";

/** Which limit a `rate_limited` error hit. */
export type RateLimitName =
  | "call_rate"
  | "hourly"
  | "bytes_24h"
  | "failed_keys"
  | "retry_backoff";

/** An error the evidence API returned, with the SDK's fields. */
export class EvidenceApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: EvidenceErrorCode | string,
    message: string,
    readonly retryable: boolean,
    readonly retryAfterSeconds: number | null,
    readonly field: string | null,
    readonly requestId?: string,
    readonly meta: EvidenceMeta = {},
    /** `rate_limited` only: the limit hit. */
    readonly limit: RateLimitName | string | null = null,
  ) {
    super(message);
    this.name = "EvidenceApiError";
  }
}

/** `403 terms_not_accepted`: the account has not accepted the current terms. Accept `terms.version` with `acceptTerms`. */
export class TermsNotAcceptedError extends EvidenceApiError {
  constructor(
    readonly terms: { version: string; url: string },
    ...args: ConstructorParameters<typeof EvidenceApiError>
  ) {
    super(...args);
    this.name = "TermsNotAcceptedError";
  }
}

/** USDC.e base units per whole token (USDC has 6 decimals). */
export const USDC_BASE_UNITS_PER_TOKEN = 1_000_000;

/**
 * Convert a bounty amount in USDC.e base units to a human-readable
 * USDC.e amount. The amount must be a non-negative integer string;
 * anything else throws, so a changed unit format fails loudly
 * instead of recording a wrong reward.
 */
export function baseUnitsToUsdcE(amount: string): number {
  if (!/^\d+$/.test(amount)) {
    throw new Error(
      `Bounty amount "${amount}" is not a non-negative integer in USDC.e base units.`,
    );
  }
  return Number(BigInt(amount)) / USDC_BASE_UNITS_PER_TOKEN;
}
