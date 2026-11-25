import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  EvidenceApiError,
  TermsNotAcceptedError,
} from "../src/delphi/evidence.js";
import { LiveDelphiAdapter } from "../src/delphi/live.js";
import { DELPHI_MARKETS_JSON_URL } from "../src/delphi/markets-json.js";
import type { AgentIdentity } from "../src/delphi/types.js";
import type { EvidenceDraft } from "../src/draft/types.js";

const READS_BASE = "https://delphi-api.gensyn.ai";
const EVIDENCE_BASE = "https://delphi.fyi/v1";

const IDENTITY: AgentIdentity = {
  agentName: "Vgen19",
  harness: "vgen19",
  model: "gemini-3.8-flash",
};

const MARKET_ID = "0x94dbba7c9b44b788a701602ab6d919ff7b7fc38a";

/** One entry exactly as the public markets.json returns it. */
function jsonEntry(overrides: Record<string, unknown> = {}) {
  const address =
    (overrides["address"] as string | undefined) ?? MARKET_ID;
  return {
    address,
    category: "votes_government",
    closesAt: "2026-11-29T06:00:00.000Z",
    dataSources: ["https://www.bk.admin.ch"],
    delphiUrl: `https://delphi.fyi/market/${address}`,
    evidenceCutoffAt: "2026-11-28T06:00:00.000Z",
    marketTier: "A",
    odds: { no: 0.483944, yes: 0.516056 },
    pots: { judgement: "20000000", settlement: "30000000" },
    question:
      "Will turnout in Switzerland's federal vote of Nov 29, 2026 be at least 50.0%, per the Federal Chancellery?",
    resolutionCriteria: "The Federal Chancellery's official turnout figure.",
    settled: null,
    status: "open",
    wave: 1,
    ...overrides,
  };
}

/** One submission exactly as the evidence API returns it (SDK shape). */
function evidenceSubmission(overrides: Record<string, unknown> = {}) {
  return {
    agentId: "Vgen19",
    canRetry: false,
    code: undefined,
    createdAt: "2026-11-24T00:05:00.000Z",
    files: [],
    id: "sub-live-1",
    judgingEstimateSeconds: 120,
    links: ["https://example.invalid/source-1"],
    markets: [
      {
        bounty: null,
        marketAddress: MARKET_ID,
        reason: null,
        settlementUpTo: null,
        status: "queued",
        verdict: null,
      },
    ],
    note: "Test evidence note.",
    retryAt: undefined,
    status: "queued",
    ...overrides,
  };
}

interface RecordedCall {
  url: string;
  init: RequestInit | undefined;
}

type FetchHandler = (
  url: string,
  init?: RequestInit,
) => Response | Promise<Response>;

function stubFetch(handler: FetchHandler) {
  const calls: RecordedCall[] = [];
  const fetchFn = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });
    return handler(url, init);
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}

function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json", ...headers },
    status,
  });
}

function headersOf(call: RecordedCall): Headers {
  return new Headers(call.init?.headers);
}

function makeClient(
  fetchFn: typeof fetch,
  overrides: Partial<{
    apiKey: string;
  }> = {},
): LiveDelphiAdapter {
  return new LiveDelphiAdapter({
    apiKey: overrides.apiKey ?? "test-delphi-key",
    fetch: fetchFn,
    identity: IDENTITY,
  });
}

function makeDraft(overrides: Partial<EvidenceDraft> = {}): EvidenceDraft {
  return {
    createdAt: "2026-11-24T00:00:00.000Z",
    files: [],
    id: "draft-1",
    links: [{ title: "Source 1", url: "https://example.invalid/source-1" }],
    marketId: MARKET_ID,
    note: "Test evidence note.",
    status: "approved",
    ...overrides,
  };
}

describe("LiveDelphiAdapter construction", () => {
  it("rejects a blank API key, naming the documented variable", () => {
    const { fetchFn } = stubFetch(() => jsonResponse({}));
    expect(
      () =>
        new LiveDelphiAdapter({
          apiKey: "   ",
          fetch: fetchFn,
          identity: IDENTITY,
        }),
    ).toThrow(/DELPHI_API_ACCESS_KEY/);
  });

  it("exposes the identity it was built with", () => {
    const { fetchFn } = stubFetch(() => jsonResponse({}));
    expect(makeClient(fetchFn).identity).toEqual(IDENTITY);
  });
});

describe("LiveDelphiAdapter market listing", () => {
  it("lists markets from the public markets.json with the competition extension", async () => {
    const { calls, fetchFn } = stubFetch((url) => {
      expect(url).toBe(DELPHI_MARKETS_JSON_URL);
      return jsonResponse([jsonEntry()]);
    });
    const client = makeClient(fetchFn);

    const markets = await client.listMarkets();

    expect(markets).toHaveLength(1);
    expect(markets[0]!.id).toBe(MARKET_ID);
    expect(markets[0]!.marketUrl).toBe(
      `https://delphi.fyi/market/${MARKET_ID}`,
    );
    expect(markets[0]!.category).toBe("votes_government");
    expect(markets[0]!.metadata?.question).toContain("Switzerland");
    expect(markets[0]!.competition?.oddsYes).toBe(0.516056);
    expect(markets[0]!.competition?.oddsNo).toBe(0.483944);
    expect(markets[0]!.competition?.judgementPot).toBe(20);
    expect(markets[0]!.competition?.settlementPot).toBe(30);
    expect(markets[0]!.competition?.rewardPot).toBe(50);
    expect(markets[0]!.competition?.evidenceCutoff).toBe(
      "2026-11-28T06:00:00.000Z",
    );
    expect(markets[0]!.competition?.tier).toBe("A");
    const headers = headersOf(calls[0]!);
    expect(headers.get("Accept")).toBe("application/json");
    expect(headers.get("Authorization")).toBeNull();
    expect(headers.get("X-API-Key")).toBeNull();
  });

  it("applies category filter and pagination locally", async () => {
    const entries = [
      jsonEntry({
        address: "0x00000000000000000000000000000000000000a1",
        category: "crypto",
      }),
      jsonEntry({
        address: "0x00000000000000000000000000000000000000b2",
        category: "politics",
      }),
      jsonEntry({
        address: "0x00000000000000000000000000000000000000c3",
        category: "crypto",
      }),
    ];
    const { fetchFn } = stubFetch(() => jsonResponse(entries));
    const client = makeClient(fetchFn);

    const page = await client.listMarkets({
      category: "crypto",
      limit: 1,
      skip: 1,
    });
    expect(page.map((market) => market.id)).toEqual([
      "0x00000000000000000000000000000000000000c3",
    ]);

    const firstTwo = await client.listMarkets({ limit: 2 });
    expect(firstTwo.map((market) => market.id)).toEqual([
      "0x00000000000000000000000000000000000000a1",
      "0x00000000000000000000000000000000000000b2",
    ]);

    // The public list only carries open markets, so any other status
    // matches nothing.
    await expect(client.listMarkets({ status: "settled" })).resolves.toEqual(
      [],
    );
  });

  it("returns an empty list when the JSON list is empty", async () => {
    const { fetchFn } = stubFetch(() => jsonResponse([]));
    const client = makeClient(fetchFn);

    await expect(client.listMarkets()).resolves.toEqual([]);
  });

  it("refuses on-chain price enrichment: it needs a signer Vgen19 has not got", async () => {
    const { calls, fetchFn } = stubFetch(() => jsonResponse([jsonEntry()]));
    const client = makeClient(fetchFn);

    await expect(
      client.listMarkets({ pricesAndImpliedProbabilities: true }),
    ).rejects.toThrow(/signer/i);
    expect(calls).toHaveLength(0);
  });

  it("fails loudly when the markets.json fetch fails", async () => {
    const { fetchFn } = stubFetch(
      () => new Response("bad gateway", { status: 502 }),
    );
    const client = makeClient(fetchFn);

    const error = await client
      .listMarkets()
      .catch((caught: unknown) => caught);
    expect((error as Error).message).toMatch(/502/);
    expect((error as Error).message).toMatch(/markets\.json/);
  });

  it("fails loudly when a market entry is missing its address", async () => {
    const entry = jsonEntry();
    delete (entry as Record<string, unknown>)["address"];
    const { fetchFn } = stubFetch(() => jsonResponse([entry]));
    const client = makeClient(fetchFn);

    await expect(client.listMarkets()).rejects.toThrow(/address/i);
  });

  it("fails loudly on a malformed list response", async () => {
    const { fetchFn } = stubFetch(() =>
      jsonResponse({ markets: [jsonEntry()] }),
    );
    const client = makeClient(fetchFn);

    await expect(client.listMarkets()).rejects.toThrow(/malformed/i);
  });

  it("fails loudly on a non-JSON response", async () => {
    const { fetchFn } = stubFetch(
      () => new Response("this is not json", { status: 200 }),
    );
    const client = makeClient(fetchFn);

    await expect(client.listMarkets()).rejects.toThrow(/not JSON/i);
  });

  it("skips entries whose status is not open instead of failing", async () => {
    const { fetchFn } = stubFetch(() =>
      jsonResponse([
        jsonEntry(),
        jsonEntry({
          address: "0x00000000000000000000000000000000000000d4",
          status: "settled",
        }),
        jsonEntry({
          address: "0x00000000000000000000000000000000000000e5",
          status: "mystery",
        }),
      ]),
    );
    const client = makeClient(fetchFn);

    const markets = await client.listMarkets();

    expect(markets).toHaveLength(1);
    expect(markets[0]!.id).toBe(MARKET_ID);
  });

  it("reads one market by id from the list", async () => {
    const { calls, fetchFn } = stubFetch((url) => {
      expect(url).toBe(DELPHI_MARKETS_JSON_URL);
      return jsonResponse([jsonEntry()]);
    });
    const client = makeClient(fetchFn);

    const market = await client.getMarket({ id: MARKET_ID });

    expect(market.id).toBe(MARKET_ID);
    expect(market.marketUrl).toBe(
      `https://delphi.fyi/market/${MARKET_ID}`,
    );
    expect(headersOf(calls[0]!).get("X-API-Key")).toBeNull();
  });

  it("names the market id when it is not in the list", async () => {
    const { fetchFn } = stubFetch(() => jsonResponse([jsonEntry()]));
    const client = makeClient(fetchFn);

    await expect(
      client.getMarket({
        id: "0x00000000000000000000000000000000000000ff",
      }),
    ).rejects.toThrow(/0x00000000000000000000000000000000000000ff/);
  });

  it("checks health with no authentication headers at all", async () => {
    const { calls, fetchFn } = stubFetch((url) => {
      expect(url).toBe(`${READS_BASE}/health`);
      return jsonResponse({ status: "ok" });
    });
    const client = makeClient(fetchFn);

    await expect(client.health()).resolves.toEqual({ status: "ok" });
    const headers = headersOf(calls[0]!);
    expect(headers.get("Authorization")).toBeNull();
    expect(headers.get("X-API-Key")).toBeNull();
  });

  it("fails loudly when the health check is down", async () => {
    const { fetchFn } = stubFetch(
      () => new Response("bad gateway", { status: 502 }),
    );
    const client = makeClient(fetchFn);

    await expect(client.health()).rejects.toThrow(/502/);
  });
});

describe("LiveDelphiAdapter evidence submission", () => {
  it("posts multipart evidence with Bearer auth and agent headers", async () => {
    let seenForm: FormData | undefined;
    const { calls, fetchFn } = stubFetch((_url, init) => {
      seenForm = init?.body as FormData;
      return jsonResponse(evidenceSubmission(), 202);
    });
    const client = makeClient(fetchFn);

    const raw = await client.submitEvidence(makeDraft(), IDENTITY);

    expect(raw).toMatchObject({ id: "sub-live-1", status: "queued" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${EVIDENCE_BASE}/submissions`);
    expect(calls[0]!.init?.method).toBe("POST");
    const headers = headersOf(calls[0]!);
    expect(headers.get("Authorization")).toBe("Bearer test-delphi-key");
    expect(headers.get("X-Agent-Id")).toBe("Vgen19");
    expect(headers.get("X-Agent-Harness")).toBe("vgen19");
    expect(headers.get("X-Agent-Model")).toBe("gemini-3.8-flash");
    expect(headers.get("X-API-Key")).toBeNull();
    expect(headers.get("Idempotency-Key")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(seenForm).toBeInstanceOf(FormData);
    expect(seenForm?.get("note")).toBe("Test evidence note.");
    expect(seenForm?.getAll("links[]")).toEqual([
      "https://example.invalid/source-1",
    ]);
    expect(seenForm?.get("marketAddress")).toBe(MARKET_ID);
    expect(seenForm?.getAll("files")).toEqual([]);
  });

  it("uses the per-call identity, not the adapter default", async () => {
    const { calls, fetchFn } = stubFetch(() =>
      jsonResponse(evidenceSubmission(), 202),
    );
    const client = makeClient(fetchFn);

    await client.submitEvidence(makeDraft(), {
      agentName: "Vgen19",
      harness: "vgen19",
      model: "gemini-3.5-flash-lite",
    });

    expect(headersOf(calls[0]!).get("X-Agent-Model")).toBe(
      "gemini-3.5-flash-lite",
    );
  });

  it("attaches draft files from disk with their basenames", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vgen19-live-files-"));
    try {
      const filePath = join(dir, "proof.txt");
      await writeFile(filePath, "evidence bytes", "utf8");
      let seenForm: FormData | undefined;
      const { fetchFn } = stubFetch((_url, init) => {
        seenForm = init?.body as FormData;
        return jsonResponse(evidenceSubmission(), 202);
      });
      const client = makeClient(fetchFn);

      await client.submitEvidence(makeDraft({ files: [filePath] }), IDENTITY);

      const files = seenForm?.getAll("files") ?? [];
      expect(files).toHaveLength(1);
      expect(files[0]).toBeInstanceOf(Blob);
      expect((files[0] as File).name).toBe("proof.txt");
      expect(await (files[0] as Blob).text()).toBe("evidence bytes");
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("fails before sending when a draft file cannot be read", async () => {
    const { calls, fetchFn } = stubFetch(() =>
      jsonResponse(evidenceSubmission(), 202),
    );
    const client = makeClient(fetchFn);

    await expect(
      client.submitEvidence(
        makeDraft({ files: ["/nonexistent/proof.txt"] }),
        IDENTITY,
      ),
    ).rejects.toThrow(/\/nonexistent\/proof\.txt/);
    expect(calls).toHaveLength(0);
  });

  it("surfaces a terms-not-accepted 403 with the version and URL", async () => {
    const { fetchFn } = stubFetch(() =>
      jsonResponse(
        {
          error: {
            code: "terms_not_accepted",
            message: "Terms not accepted",
            terms: {
              url: "https://example.invalid/terms/v3",
              version: "v3",
            },
          },
        },
        403,
      ),
    );
    const client = makeClient(fetchFn);

    const error = await client
      .submitEvidence(makeDraft(), IDENTITY)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TermsNotAcceptedError);
    expect(error).toBeInstanceOf(EvidenceApiError);
    const termsError = error as TermsNotAcceptedError;
    expect(termsError.terms).toEqual({
      url: "https://example.invalid/terms/v3",
      version: "v3",
    });
    expect(termsError.status).toBe(403);
    expect(termsError.code).toBe("terms_not_accepted");
  });

  it("maps a rate-limited 429 with its limit and retry-after", async () => {
    const { fetchFn } = stubFetch(() =>
      jsonResponse(
        {
          error: {
            code: "rate_limited",
            limit: "hourly",
            message: "Hourly submit limit reached",
            retryAfterSeconds: 1800,
            retryable: true,
          },
        },
        429,
      ),
    );
    const client = makeClient(fetchFn);

    const error = await client
      .submitEvidence(makeDraft(), IDENTITY)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(EvidenceApiError);
    const apiError = error as EvidenceApiError;
    expect(apiError.status).toBe(429);
    expect(apiError.code).toBe("rate_limited");
    expect(apiError.retryable).toBe(true);
    expect(apiError.retryAfterSeconds).toBe(1800);
    expect(apiError.limit).toBe("hourly");
  });

  it("maps an unauthorized 401 as an evidence error, not a crash", async () => {
    const { fetchFn } = stubFetch(() =>
      jsonResponse(
        { error: { code: "unauthorized", message: "Bad API key" } },
        401,
      ),
    );
    const client = makeClient(fetchFn);

    const error = await client
      .submitEvidence(makeDraft(), IDENTITY)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(EvidenceApiError);
    expect((error as EvidenceApiError).code).toBe("unauthorized");
  });
});

describe("LiveDelphiAdapter evidence reads", () => {
  it("reads the current terms", async () => {
    const { calls, fetchFn } = stubFetch(() =>
      jsonResponse({
        acceptedAt: null,
        url: "https://example.invalid/terms/v3",
        version: "v3",
      }),
    );
    const client = makeClient(fetchFn);

    const terms = await client.getTerms();

    expect(terms).toEqual({
      acceptedAt: null,
      url: "https://example.invalid/terms/v3",
      version: "v3",
    });
    expect(calls[0]!.url).toBe(`${EVIDENCE_BASE}/terms`);
    expect(headersOf(calls[0]!).get("Authorization")).toBe(
      "Bearer test-delphi-key",
    );
  });

  it("accepts a terms version with a JSON body", async () => {
    const { calls, fetchFn } = stubFetch((_url, init) => {
      expect(init?.body).toBe(JSON.stringify({ termsVersion: "v3" }));
      return jsonResponse({
        acceptedAt: "2026-11-24T00:00:00.000Z",
        version: "v3",
      });
    });
    const client = makeClient(fetchFn);

    const acceptance = await client.acceptTerms("v3");

    expect(acceptance).toEqual({
      acceptedAt: "2026-11-24T00:00:00.000Z",
      version: "v3",
    });
    expect(calls[0]!.url).toBe(`${EVIDENCE_BASE}/terms/acceptance`);
    expect(calls[0]!.init?.method).toBe("POST");
    expect(headersOf(calls[0]!).get("Content-Type")).toBe("application/json");
  });

  it("reads one submission by id", async () => {
    const { calls, fetchFn } = stubFetch(() =>
      jsonResponse(evidenceSubmission({ status: "judged" })),
    );
    const client = makeClient(fetchFn);

    const submission = await client.getSubmission("sub-live-1");

    expect(submission.id).toBe("sub-live-1");
    expect(submission.status).toBe("judged");
    expect(calls[0]!.url).toBe(`${EVIDENCE_BASE}/submissions/sub-live-1`);
  });

  it("lists submissions with filters", async () => {
    const { calls, fetchFn } = stubFetch(() =>
      jsonResponse({ items: [evidenceSubmission()], nextCursor: null }),
    );
    const client = makeClient(fetchFn);

    const page = await client.listSubmissions({
      agentId: "Vgen19",
      limit: 10,
      market: MARKET_ID,
    });

    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBeNull();
    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get("market")).toBe(MARKET_ID);
    expect(url.searchParams.get("agentId")).toBe("Vgen19");
    expect(url.searchParams.get("limit")).toBe("10");
  });

  it("reads the entry state for a market", async () => {
    const { calls, fetchFn } = stubFetch(() =>
      jsonResponse({
        canSubmit: true,
        judgementPotRemainingBaseUnits: "250000000",
        rateLimit: { resetAt: "2026-11-24T01:00:00.000Z" },
        remainingOnMarket: 3,
      }),
    );
    const client = makeClient(fetchFn);

    const state = await client.getEntryState(MARKET_ID);

    expect(state.canSubmit).toBe(true);
    expect(state.remainingOnMarket).toBe(3);
    expect(calls[0]!.url).toBe(
      `${EVIDENCE_BASE}/markets/${MARKET_ID}/entry-state`,
    );
  });

  it("reads the submission limits", async () => {
    const { calls, fetchFn } = stubFetch(() =>
      jsonResponse({
        dailyCapLeft: 40,
        dailyCapResetAt: "2026-11-25T00:00:00.000Z",
        hourEndsAt: "2026-11-24T01:00:00.000Z",
        submitsLeftThisHour: 9,
      }),
    );
    const client = makeClient(fetchFn);

    const limits = await client.getLimits();

    expect(limits.submitsLeftThisHour).toBe(9);
    expect(calls[0]!.url).toBe(`${EVIDENCE_BASE}/limits`);
  });

  it("retries a submission", async () => {
    const { calls, fetchFn } = stubFetch(() =>
      jsonResponse(evidenceSubmission({ status: "queued" })),
    );
    const client = makeClient(fetchFn);

    const submission = await client.retrySubmission("sub-live-1");

    expect(submission.status).toBe("queued");
    expect(calls[0]!.url).toBe(
      `${EVIDENCE_BASE}/submissions/sub-live-1/retry`,
    );
    expect(calls[0]!.init?.method).toBe("POST");
  });

  it("polls until a submission reaches a terminal status", async () => {
    const states = ["queued", "judging", "judged"];
    let callCount = 0;
    const { fetchFn } = stubFetch(() =>
      jsonResponse(
        evidenceSubmission({ status: states[Math.min(callCount++, 2)] }),
      ),
    );
    const client = makeClient(fetchFn);

    const submission = await client.waitForSubmission("sub-live-1", {
      defaultIntervalMs: 1,
      timeoutMs: 5000,
    });

    expect(submission.status).toBe("judged");
    expect(callCount).toBe(3);
  });

  it("times out while a submission stays queued", async () => {
    const { fetchFn } = stubFetch(() =>
      jsonResponse(evidenceSubmission({ status: "queued" })),
    );
    const client = makeClient(fetchFn);

    await expect(
      client.waitForSubmission("sub-live-1", {
        defaultIntervalMs: 1,
        timeoutMs: 5,
      }),
    ).rejects.toThrow(/timed out/i);
  });
});
