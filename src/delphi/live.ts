/**
 * The live Delphi client (ticket 08): the `DelphiAdapter`
 * implementation that talks to the real Delphi APIs. Every endpoint,
 * header, and response shape comes from the official Delphi SDK
 * (gensyn-ai/gensyn-delphi-sdk); nothing here is invented.
 *
 * Two APIs, one key, two placements:
 *
 * - Reads (`listMarkets`, `getMarket`): the reads API at
 *   `https://delphi-api.gensyn.ai`, authenticated with the
 *   `X-API-Key` header plus `X-Delphi-Mode: competition` (the SDK
 *   sends the mode header automatically for competition networks).
 *   `health` needs no authentication at all. The reads API does
 *   NOT return `marketUrl`; the client builds it from the app URL,
 *   exactly as the SDK does.
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
 * THE PLACEMENT CAVEAT — read this before debugging a 401. The
 * Delphi API key is stored in the Muse Secure Vault with the
 * placement `bearer_header`: the runtime swaps the surrogate for
 * the real key on Bearer evidence calls. A surrogate placed by hand
 * in `X-API-Key` for reads may reach Delphi unswapped. Verified
 * 21 November 2026: `health` works on both networks, but
 * `listMarkets` returns 401 `{"error":"invalid API key"}` on both,
 * and sending Bearer alone returns 401 `missing X-API-Key header`
 * (the reads API ignores Bearer). THE KEY IS NOW PROVEN
 * VALID: the decisive Bearer test passed 26 November 2026
 * (Mainnet key, `get_terms`/`get_limits` 200 on
 * `https://delphi.fyi/v1`; account registered, terms v2026-11-18
 * accepted). What is still unverified is whether the reads API
 * accepts the Mainnet key in `X-API-Key`: if a cycle still 401s
 * on reads, register a SECOND connection with placement
 * `custom_header:X-API-Key` for read hosts and pass its key as
 * `DELPHI_API_READ_KEY` (the escape hatch below). This client
 * does NOT assume reads work: it implements them exactly as the
 * SDK specifies, and a 401 on reads fails loudly with a pointer
 * to this note.
 *
 * The escape hatch: `DELPHI_API_READ_KEY`, when set, is used for
 * reads ONLY (the `X-API-Key` header). Evidence calls always use
 * the main key as Bearer. The two keys may be the same value or
 * different connections.
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
 * NOT come from the reads API: the SDK's starter agent reads them
 * from the competition site's `/markets.json`. This client does
 * not fetch that file yet, so live markets carry no competition
 * extension until that wiring lands — picking works without it
 * (odds and cutoffs show as n/a), it just cannot prefer markets
 * by odds or skip past-cutoff markets.
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
import type { AgentIdentity, Market, MarketStatus } from "./types.js";

/** Reads base URL for the competition network (SDK default). */
export const DELPHI_READS_BASE_URL = "https://delphi-api.gensyn.ai";
/** Delphi app URL for the Mainnet network (market links). */
export const DELPHI_APP_URL = "https://app.delphi.fyi";
/** Evidence base URL: `https://delphi.fyi/v1` (competition.md v1.0). */
export const DELPHI_EVIDENCE_BASE_URL = "https://delphi.fyi/v1";

const MARKET_STATUSES: readonly MarketStatus[] = [
  "open",
  "awaiting_settlement",
  "settled",
  "expired",
  "failed",
];

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
   * The Delphi API key: Bearer for evidence calls, `X-API-Key` for
   * reads (unless `readApiKey` is set). From `DELPHI_API_ACCESS_KEY`
   * (`DELPHI_API_KEY` also works as an alias).
   */
  apiKey: string;
  /**
   * Optional separate key for reads only (the placement escape
   * hatch). From `DELPHI_API_READ_KEY` when set.
   */
  readApiKey?: string;
  /** The identity sent with every request. */
  identity: AgentIdentity;
  /** Reads base URL. Defaults to the competition network. */
  readsBaseUrl?: string;
  /** Evidence base URL, including `/v1`. Defaults to the competition network. */
  evidenceBaseUrl?: string;
  /** Delphi app URL, used to build `marketUrl`. Defaults to the competition network. */
  appUrl?: string;
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
  private readonly readApiKey: string;
  private readonly readsBase: string;
  private readonly evidenceBase: string;
  private readonly appUrl: string;
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
    const readApiKey = options.readApiKey?.trim() ?? "";
    this.readApiKey = readApiKey === "" ? apiKey : readApiKey;
    this.identity = options.identity;
    this.readsBase = (options.readsBaseUrl ?? DELPHI_READS_BASE_URL).replace(
      /\/+$/,
      "",
    );
    this.evidenceBase = (
      options.evidenceBaseUrl ?? DELPHI_EVIDENCE_BASE_URL
    ).replace(/\/+$/, "");
    this.appUrl = (options.appUrl ?? DELPHI_APP_URL).replace(/\/+$/, "");
    this.fetchFn = options.fetch ?? fetch;
    this.evidenceHeaders = {
      Accept: "application/json",
      Authorization: `Bearer ${this.apiKey}`,
      "X-Agent-Harness": options.identity.harness,
      "X-Agent-Id": options.identity.agentName,
      "X-Agent-Model": options.identity.model,
    };
  }

  async listMarkets(params: ListMarketsParams = {}): Promise<Market[]> {
    if (params.pricesAndImpliedProbabilities === true) {
      throw new Error(
        "listMarkets with pricesAndImpliedProbabilities needs on-chain " +
          "price calls with a signer; Vgen19 has no signer and never " +
          "makes on-chain calls. Call listMarkets without it.",
      );
    }
    const response = await this.readsGet<unknown>("/markets", {
      category: params.category,
      competitionId: params.competitionId,
      limit: params.limit,
      orderBy: params.orderBy,
      skip: params.skip,
      status: params.status,
      verifiable: params.verifiable,
    });
    if (
      typeof response !== "object" ||
      response === null ||
      Array.isArray(response)
    ) {
      throw new DelphiReadError(
        "Delphi listMarkets returned a malformed response: " +
          "expected an object with a `markets` list.",
      );
    }
    const markets =
      (response as { markets?: unknown }).markets ?? null;
    if (markets === null) {
      return [];
    }
    if (!Array.isArray(markets)) {
      throw new DelphiReadError(
        "Delphi listMarkets returned a malformed response: `markets` is not a list.",
      );
    }
    return markets.map((market, index) => this.parseMarket(market, index));
  }

  async getMarket(params: GetMarketParams): Promise<Market> {
    let response: unknown;
    try {
      response = await this.readsGet<unknown>(
        `/markets/${encodeURIComponent(params.id)}`,
        params.competitionId !== undefined
          ? { competitionId: params.competitionId }
          : undefined,
      );
    } catch (error) {
      if (error instanceof DelphiReadError) {
        throw new DelphiReadError(
          `Reading market ${params.id} failed: ${error.message}`,
          error.status,
        );
      }
      throw error;
    }
    return this.parseMarket(response, 0);
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

  /**
   * Validate one market from the reads API and build its `marketUrl`
   * (the API does not return one; the SDK builds it the same way).
   * Only the fields the agent reasons about are validated — `id`,
   * `appMarketId`, `status` — so a new API field never breaks the
   * sync, but a market missing its identity fails loudly instead of
   * poisoning the store.
   */
  private parseMarket(value: unknown, index: number): Market {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new DelphiReadError(
        `Delphi returned a market that is not an object (index ${index}).`,
      );
    }
    const record = value as Record<string, unknown>;
    const id = record["id"];
    if (typeof id !== "string" || id === "") {
      throw new DelphiReadError(
        `Delphi returned a market without an id (index ${index}).`,
      );
    }
    const appMarketId = record["appMarketId"];
    if (typeof appMarketId !== "string" || appMarketId === "") {
      throw new DelphiReadError(
        `Delphi returned market ${id} without an appMarketId.`,
      );
    }
    const status = record["status"];
    if (
      typeof status !== "string" ||
      !(MARKET_STATUSES as readonly string[]).includes(status)
    ) {
      throw new DelphiReadError(
        `Delphi returned market ${id} with an unknown status: ${String(status)}.`,
      );
    }
    return {
      ...(record as unknown as Market),
      marketUrl: `${this.appUrl}/market/${appMarketId}`,
    };
  }

  private async readsGet<T>(
    path: string,
    query?: Record<string, string | number | boolean | undefined>,
  ): Promise<T> {
    const url = new URL(path, this.readsBase);
    if (query !== undefined) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null) {
          url.searchParams.set(key, String(value));
        }
      }
    }
    const response = await this.fetchFn(url.toString(), {
      headers: {
        Accept: "application/json",
        "X-API-Key": this.readApiKey,
        "X-Delphi-Mode": "competition",
      },
      method: "GET",
    });
    const text = await response.text();
    if (!response.ok) {
      throw this.readsError(response.status, text);
    }
    return this.parseReadsJson<T>(text, `GET ${path}`);
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

  private readsError(status: number, body: string): DelphiReadError {
    let detail = body.slice(0, 200);
    try {
      const json = JSON.parse(body) as { error?: unknown };
      if (typeof json?.error === "string" && json.error !== "") {
        detail = json.error;
      }
    } catch {
      // Plain-text body: keep the raw text.
    }
    let message = `Delphi read failed (${status}): ${detail}`;
    if (status === 401) {
      message +=
        " The read key was rejected — but the key may still be valid " +
        "for Bearer evidence calls: reads and evidence use different " +
        "placements (see the placement note in src/delphi/live.ts), " +
        "and DELPHI_API_READ_KEY can carry a separate read key.";
    }
    return new DelphiReadError(message, status);
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
