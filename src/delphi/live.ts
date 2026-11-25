/**
 * The live Delphi client (ticket 08): the `DelphiAdapter`
 * implementation that talks to the real Delphi APIs. Every endpoint,
 * header, and response shape comes from the official Delphi SDK
 * (gensyn-ai/gensyn-delphi-sdk); nothing here is invented.
 *
 * Two APIs, one key, two placements:
 *
 * - Market listing (`listMarkets`, `getMarket`): the public market
 *   list at `https://competition.delphi.fyi/markets.json` — the same
 *   list as the competition grid, per competition.md v1.0. The file
 *   is public and needs no authentication, so no API key is sent.
 *   See `markets-json.ts`. The reads API at
 *   `https://delphi-api.gensyn.ai` is NOT used for markets: it
 *   returns HTTP 401 `{"error":"invalid API key"}` for
 *   `listMarkets` and `getMarket` with the Mainnet key (verified
 *   26 November 2026). It serves only the unauthenticated `health`
 *   check now.
 * - Evidence (`submitEvidence` and the `/v1` reads): the evidence
 *   API at `https://delphi.fyi/v1` (competition.md v1.0: all 8
 *   Evidence API routes live under `https://delphi.fyi/v1`),
 *   authenticated with `Authorization: Bearer`. Submissions are
 *   multipart FormData (`note`, `links[]`, `files`,
 *   `marketAddress`) with an `Idempotency-Key` header. Confirmed
 *   live 26 November 2026: the Mainnet key works (Bearer
 *   `get_terms`/`get_limits` return 200; the old competition host
 *   `agent-competition.gensyn.ai` is still behind Cloudflare
 *   Access and is no longer the API host).
 *
 * THE READS API IS DEAD FOR THIS ACCOUNT — read this before
 * debugging a 401. The reads API (`delphi-api.gensyn.ai`) rejects
 * the Mainnet key with 401 `{"error":"invalid API key"}` on
 * `listMarkets` and `getMarket` (verified 26 November 2026), so
 * market listing reads the public markets.json instead and sends no
 * key at all. Do NOT "fix" a listing failure by wiring a second
 * read connection: the listing does not use the reads API. The key
 * itself is proven valid: Bearer calls to the evidence API
 * (`https://delphi.fyi/v1`) return 200 (account registered, terms
 * v2026-11-18 accepted 26 November 2026). There is no read-key
 * option anymore (`DELPHI_API_READ_KEY` was removed with the reads
 * listing): if the reads API ever revives, add the wiring then —
 * do not pre-emptively reintroduce it.
 *
 * Terms: the evidence API returns 403 `terms_not_accepted` until
 * the account accepts the current terms. This client implements
 * `getTerms` and `acceptTerms`, but NOTHING in the agent calls
 * `acceptTerms` — accepting terms changes account state, so the
 * operator runs it (once, at the opening) through the connector
 * helper or a manual call. A 403 surfaces as
 * `TermsNotAcceptedError` carrying the version and URL to accept.
 *
 * No on-chain calls: `pricesAndImpliedProbabilities` needs a
 * signer and on-chain multicalls, which Vgen19 does not have, so
 * requesting it throws a clear error instead of silently returning
 * markets without prices.
 *
 * Competition-only fields (odds, reward pot, evidence cutoff) do
 * NOT come from the reads API: the client reads them from the
 * competition site's public `/markets.json` (`markets-json.ts`), so
 * live markets carry the competition extension (odds, pots,
 * evidence cutoff, tier, wave).
 */

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

import type { EvidenceDraft } from "../draft/types.js";
import type {
  DelphiAdapter,
  GetMarketParams,
  ListMarketsParams,
} from "./adapter.js";
import {
  EvidenceApiError,
  TERMINAL_SUBMISSION_STATUSES,
  TermsNotAcceptedError,
  type EntryState,
  type EvidenceLimits,
  type EvidenceMeta,
  type EvidenceResult,
  type EvidenceTerms,
  type Submission,
  type SubmissionSummary,
  type TermsAcceptance,
} from "./evidence.js";
import {
  DELPHI_MARKETS_JSON_URL,
  fetchMarketsJson,
  MarketsJsonError,
} from "./markets-json.js";
import type { AgentIdentity, Market } from "./types.js";

/** Reads base URL for the competition network (SDK default). */
export const DELPHI_READS_BASE_URL = "https://delphi-api.gensyn.ai";
/** Evidence base URL: `https://delphi.fyi/v1` (competition.md v1.0). */
export const DELPHI_EVIDENCE_BASE_URL = "https://delphi.fyi/v1";

/** An error the reads API returned (or a malformed reads response). */
export class DelphiReadError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = "DelphiReadError";
  }
}

export interface LiveDelphiClientOptions {
  /**
   * The Delphi API key: Bearer for evidence calls. Market listing
   * reads the public markets.json and sends no key. From
   * `DELPHI_API_ACCESS_KEY` (`DELPHI_API_KEY` also works as an alias).
   */
  apiKey: string;
  /** The identity sent with every request. */
  identity: AgentIdentity;
  /** Reads base URL, used only by the unauthenticated health check. */
  readsBaseUrl?: string;
  /** Evidence base URL, including `/v1`. Defaults to the competition network. */
  evidenceBaseUrl?: string;
  /** Public markets.json URL override for tests. */
  marketsJsonUrl?: string;
  /** Fetch override for tests. Defaults to the global fetch. */
  fetch?: typeof fetch;
}

interface EvidenceRequestOptions {
  query?: Record<string, string | number | undefined>;
  body?: FormData | string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

type EvidenceErrorBody = {
  error?: {
    code?: string;
    field?: string;
    limit?: string;
    message?: string;
    retryable?: boolean;
    retryAfterSeconds?: number;
    terms?: { url: string; version: string };
  };
  requestId?: string;
  terms?: { url: string; version: string };
};

const headerNumber = (value: string | null): number | undefined => {
  if (value === null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

function readEvidenceMeta(headers: Headers): EvidenceMeta {
  const limit = headerNumber(headers.get("RateLimit-Limit"));
  return {
    contractVersion: headers.get("X-Contract-Version") ?? undefined,
    location: headers.get("Location") ?? undefined,
    rateLimit:
      limit === undefined
        ? undefined
        : {
            limit,
            remaining: headerNumber(headers.get("RateLimit-Remaining")) ?? 0,
            reset: headerNumber(headers.get("RateLimit-Reset")) ?? 0,
          },
    requestId: headers.get("X-Request-Id") ?? undefined,
    retryAfterSeconds: headerNumber(headers.get("Retry-After")),
    warnings: headers.get("X-Delphi-Warnings") ?? undefined,
  };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export class LiveDelphiAdapter implements DelphiAdapter {
  readonly identity: AgentIdentity;
  private readonly apiKey: string;
  private readonly readsBase: string;
  private readonly evidenceBase: string;
  private readonly marketsJsonUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly evidenceHeaders: Record<string, string>;

  constructor(options: LiveDelphiClientOptions) {
    const apiKey = options.apiKey?.trim() ?? "";
    if (apiKey === "") {
      throw new Error(
        "LiveDelphiAdapter needs a Delphi API key. " +
          "Set DELPHI_API_ACCESS_KEY (DELPHI_API_KEY works as an alias).",
      );
    }
    this.apiKey = apiKey;
    this.identity = options.identity;
    this.readsBase = (options.readsBaseUrl ?? DELPHI_READS_BASE_URL).replace(
      /\/+$/,
      "",
    );
    this.evidenceBase = (
      options.evidenceBaseUrl ?? DELPHI_EVIDENCE_BASE_URL
    ).replace(/\/+$/, "");
    this.marketsJsonUrl = (
      options.marketsJsonUrl ?? DELPHI_MARKETS_JSON_URL
    ).replace(/\/+$/, "");
    this.fetchFn = options.fetch ?? fetch;
    this.evidenceHeaders = {
      Accept: "application/json",
      Authorization: `Bearer ${this.apiKey}`,
      "X-Agent-Harness": options.identity.harness,
      "X-Agent-Id": options.identity.agentName,
      "X-Agent-Model": options.identity.model,
    };
  }

  /**
   * Read the competition market list from the public markets.json.
   * The file is fetched whole on every call and the filters are
   * applied locally: the list is small (27 markets at wave 1) and
   * the sync stops after the first short page, so one fetch per
   * sync is the normal case. `orderBy` and `competitionId` are
   * ignored — the file is the single competition list in the
   * competition's own order. No API key is sent: the file is public.
   */
  async listMarkets(params: ListMarketsParams = {}): Promise<Market[]> {
    if (params.pricesAndImpliedProbabilities === true) {
      throw new Error(
        "listMarkets with pricesAndImpliedProbabilities needs on-chain " +
          "price calls with a signer; Vgen19 has no signer and never " +
          "makes on-chain calls. Call listMarkets without it.",
      );
    }
    const markets = await fetchMarketsJson(
      this.fetchFn,
      this.marketsJsonUrl,
    );
    if (params.status !== undefined && params.status !== "open") {
      // The public list only carries open markets (non-open entries
      // are skipped at parse time), so any other status matches nothing.
      return [];
    }
    let result = markets;
    if (params.category !== undefined) {
      result = result.filter(
        (market) => market.category === params.category,
      );
    }
    if (params.verifiable === true) {
      // markets.json states no verifiability, so no market in the
      // list is known-verifiable.
      return [];
    }
    const skip = params.skip ?? 0;
    const limit = params.limit;
    return result.slice(
      skip,
      limit === undefined ? undefined : skip + limit,
    );
  }

  /**
   * Read one market by its contract address from the public
   * markets.json. `competitionId` is ignored: the file is the single
   * competition list.
   */
  async getMarket(params: GetMarketParams): Promise<Market> {
    const markets = await fetchMarketsJson(
      this.fetchFn,
      this.marketsJsonUrl,
    );
    const market = markets.find((candidate) => candidate.id === params.id);
    if (market === undefined) {
      throw new MarketsJsonError(
        `Delphi markets.json has no open market with id ${params.id}.`,
      );
    }
    return market;
  }

  async health(): Promise<{ status: string }> {
    const url = new URL("/health", this.readsBase);
    const response = await this.fetchFn(url.toString(), {
      headers: {
        Accept: "application/json",
        "X-Delphi-Mode": "competition",
      },
      method: "GET",
    });
    const text = await response.text();
    if (!response.ok) {
      throw new DelphiReadError(
        `Delphi health check failed (${response.status}): ${text.slice(0, 200)}`,
        response.status,
      );
    }
    return this.parseReadsJson<{ status: string }>(text, "health");
  }

  async submitEvidence(
    draft: EvidenceDraft,
    meta: AgentIdentity,
  ): Promise<unknown> {
    const form = new FormData();
    form.append("note", draft.note);
    for (const link of draft.links) {
      form.append("links[]", link.url);
    }
    for (const filePath of draft.files) {
      let content: Buffer;
      try {
        content = await readFile(filePath);
      } catch {
        throw new Error(
          `Cannot read evidence file ${filePath} for draft ${draft.id}; nothing was sent to Delphi.`,
        );
      }
      form.append("files", new Blob([content]), basename(filePath));
    }
    form.append("marketAddress", draft.marketId);
    const result = await this.evidenceRequest<Submission>(
      "POST",
      "/submissions",
      {
        body: form,
        headers: {
          "Idempotency-Key": randomUUID(),
          "X-Agent-Harness": meta.harness,
          "X-Agent-Id": meta.agentName,
          "X-Agent-Model": meta.model,
        },
      },
    );
    return result.data;
  }

  /**
   * Read the current state of a submission from Delphi. The outcome
   * sync uses it to refresh submissions that were still queued when
   * they were sent.
   */
  async getSubmission(submissionId: string): Promise<Submission> {
    const result = await this.evidenceRequest<Submission>(
      "GET",
      `/submissions/${encodeURIComponent(submissionId)}`,
    );
    return result.data;
  }

  async listSubmissions(
    query: {
      market?: string;
      agentId?: string;
      cursor?: string;
      limit?: number;
    } = {},
  ): Promise<{ items: SubmissionSummary[]; nextCursor: string | null }> {
    const result = await this.evidenceRequest<{
      items: SubmissionSummary[];
      nextCursor: string | null;
    }>("GET", "/submissions", { query });
    return result.data;
  }

  async getEntryState(market: string): Promise<EntryState> {
    const result = await this.evidenceRequest<EntryState>(
      "GET",
      `/markets/${encodeURIComponent(market)}/entry-state`,
    );
    return result.data;
  }

  async retrySubmission(submissionId: string): Promise<Submission> {
    const result = await this.evidenceRequest<Submission>(
      "POST",
      `/submissions/${encodeURIComponent(submissionId)}/retry`,
    );
    return result.data;
  }

  async getLimits(): Promise<EvidenceLimits> {
    const result = await this.evidenceRequest<EvidenceLimits>(
      "GET",
      "/limits",
    );
    return result.data;
  }

  async getTerms(): Promise<EvidenceTerms> {
    const result = await this.evidenceRequest<EvidenceTerms>("GET", "/terms");
    return result.data;
  }

  /**
   * Accept the terms `version` (it must be the current one) once for
   * the account. STATE-CHANGING: nothing in the agent calls this.
   * The operator runs it once, at the opening, after reading the
   * terms at the URL `getTerms` returns.
   */
  async acceptTerms(version: string): Promise<TermsAcceptance> {
    const result = await this.evidenceRequest<TermsAcceptance>(
      "POST",
      "/terms/acceptance",
      {
        body: JSON.stringify({ termsVersion: version }),
        headers: { "Content-Type": "application/json" },
      },
    );
    return result.data;
  }

  /**
   * Poll `getSubmission` until the status is terminal, sleeping for
   * `Retry-After` (else `defaultIntervalMs`) between calls. Throws
   * on timeout or abort. The runner does not call this today: the
   * outcome sync refreshes queued submissions on the next cycle
   * instead. Kept for the opening-day operator, who may want one
   * submission's verdict within minutes.
   */
  async waitForSubmission(
    submissionId: string,
    options: {
      timeoutMs?: number;
      defaultIntervalMs?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<Submission> {
    const deadline = Date.now() + (options.timeoutMs ?? 300_000);
    for (;;) {
      options.signal?.throwIfAborted();
      const result = await this.evidenceRequest<Submission>(
        "GET",
        `/submissions/${encodeURIComponent(submissionId)}`,
        { signal: options.signal },
      );
      if (TERMINAL_SUBMISSION_STATUSES.includes(result.data.status)) {
        return result.data;
      }
      const wait =
        (result.meta.retryAfterSeconds ?? 0) * 1000 ||
        (options.defaultIntervalMs ?? 2000);
      if (Date.now() + wait > deadline) {
        throw new Error(
          `Timed out waiting for submission ${submissionId} to be judged.`,
        );
      }
      await sleep(wait, options.signal);
    }
  }

  private parseReadsJson<T>(text: string, what: string): T {
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new DelphiReadError(
        `Delphi returned a response that is not JSON for ${what}: ${text.slice(0, 200)}`,
      );
    }
  }

  private async evidenceRequest<T>(
    method: string,
    path: string,
    options: EvidenceRequestOptions = {},
  ): Promise<EvidenceResult<T>> {
    const url = new URL(this.evidenceBase + path);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
    const response = await this.fetchFn(url.toString(), {
      body: options.body,
      headers: { ...this.evidenceHeaders, ...options.headers },
      method,
      signal: options.signal,
    });
    const meta = readEvidenceMeta(response.headers);
    const text = await response.text();
    let json: EvidenceErrorBody | undefined;
    try {
      json = text ? (JSON.parse(text) as EvidenceErrorBody) : undefined;
    } catch {
      // Non-JSON body: only the status and text survive.
    }
    if (!response.ok) {
      throw evidenceErrorFrom(response.status, json, text, meta);
    }
    return { data: json as T, meta };
  }
}

function evidenceErrorFrom(
  status: number,
  json: EvidenceErrorBody | undefined,
  text: string,
  meta: EvidenceMeta,
): EvidenceApiError {
  const error = json?.error;
  const args = [
    status,
    error?.code ?? "server_error",
    error?.message ??
      `Evidence API request failed (${status}): ${text.slice(0, 200)}`,
    error?.retryable ?? status >= 500,
    error?.retryAfterSeconds ?? meta.retryAfterSeconds ?? null,
    error?.field ?? null,
    json?.requestId ?? meta.requestId,
    meta,
    error?.limit ?? null,
  ] as const;
  // The contract puts `terms` on the error; read it from the body root too.
  const terms = error?.terms ?? json?.terms;
  if (status === 403 && error?.code === "terms_not_accepted" && terms) {
    return new TermsNotAcceptedError(terms, ...args);
  }
  return new EvidenceApiError(...args);
}
