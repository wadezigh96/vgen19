import { describe, expect, it } from "vitest";

import { createDelphiAdapter } from "../src/delphi/index.js";
import { LiveDelphiAdapter } from "../src/delphi/live.js";
import { fixtureMarkets } from "../src/delphi/fixtures.js";
import { StubDelphiAdapter } from "../src/delphi/stub.js";
import type { EvidenceDraft } from "../src/draft/types.js";
import { parseSubmissionReceipt } from "../src/submit/receipt.js";

const EXPECTED_QUESTIONS = [
  "Will the Republic of Zanara hold a general election before 31 December 2026?",
  "Will the Meridian Central Bank raise its policy rate above 5% before 1 March 2027?",
  "Will Northgate Rovers win the 2027 Aurora Cup?",
  "Will the AURORA token reach a market capitalisation above $1 billion before 1 June 2027?",
  "Will Quantleaf ship a 1,000-qubit quantum computer before 1 January 2028?",
];

describe("StubDelphiAdapter", () => {
  it("returns the recorded fixture markets in the real Delphi Market shape", async () => {
    const adapter = new StubDelphiAdapter();

    const markets = await adapter.listMarkets();

    expect(markets).toHaveLength(5);
    expect(markets.map((market) => market.metadata?.question)).toEqual(
      EXPECTED_QUESTIONS,
    );
    for (const market of markets) {
      // id is the on-chain market contract address (obviously fake here).
      expect(market.id).toMatch(/^0x[0-9a-f]{40}$/);
      expect(market.appMarketId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(market.marketUrl).toContain(market.id);
      expect([
        "open",
        "awaiting_settlement",
        "settled",
        "expired",
        "failed",
      ]).toContain(market.status);
      expect(market.metadata?.outcomes).toEqual(["Yes", "No"]);
      expect(market.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(market.settlesAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(typeof market.verifiable).toBe("boolean");
    }
    expect(markets.map((market) => market.category)).toEqual([
      "politics",
      "economics",
      "sports",
      "crypto",
      "technology",
    ]);
    // One market is closed to trading but not yet settled.
    expect(markets.filter((market) => market.status === "open")).toHaveLength(4);
    expect(
      markets.filter((market) => market.status === "awaiting_settlement"),
    ).toHaveLength(1);
  });

  it("carries competition-2 fields as an optional extension", async () => {
    const adapter = new StubDelphiAdapter();

    const markets = await adapter.listMarkets();

    const withCompetition = markets.filter(
      (market) => market.competition !== undefined,
    );
    expect(withCompetition).toHaveLength(4);
    for (const market of withCompetition) {
      const competition = market.competition!;
      expect(competition.oddsYes).toBeGreaterThan(0);
      expect(competition.oddsYes).toBeLessThan(1);
      expect(competition.oddsNo).toBeGreaterThan(0);
      expect(competition.oddsNo).toBeLessThan(1);
      expect(competition.evidenceCutoff).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(competition.rewardPot).toBeGreaterThan(0);
    }
    // The market awaiting settlement carries no live odds, pot, or cutoff.
    const awaiting = markets.find(
      (market) => market.status === "awaiting_settlement",
    )!;
    expect(awaiting.competition).toBeUndefined();
  });

  it("honors the status filter", async () => {
    const adapter = new StubDelphiAdapter();

    const open = await adapter.listMarkets({ status: "open" });
    const awaiting = await adapter.listMarkets({
      status: "awaiting_settlement",
    });
    const settled = await adapter.listMarkets({ status: "settled" });

    expect(open).toHaveLength(4);
    expect(open.every((market) => market.status === "open")).toBe(true);
    expect(awaiting).toHaveLength(1);
    expect(awaiting[0]!.metadata?.question).toBe(
      "Will Northgate Rovers win the 2027 Aurora Cup?",
    );
    expect(settled).toHaveLength(0);
  });

  it("honors skip/limit pagination", async () => {
    const adapter = new StubDelphiAdapter();

    const firstPage = await adapter.listMarkets({ limit: 2 });
    const secondPage = await adapter.listMarkets({ limit: 2, skip: 2 });
    const rest = await adapter.listMarkets({ skip: 4 });

    expect(firstPage.map((market) => market.id)).toEqual([
      fixtureMarkets[0]!.id,
      fixtureMarkets[1]!.id,
    ]);
    expect(secondPage.map((market) => market.id)).toEqual([
      fixtureMarkets[2]!.id,
      fixtureMarkets[3]!.id,
    ]);
    expect(rest.map((market) => market.id)).toEqual([fixtureMarkets[4]!.id]);
  });

  it("clamps negative skip/limit to zero instead of slicing from the end", async () => {
    const adapter = new StubDelphiAdapter();

    const markets = await adapter.listMarkets({ limit: -1, skip: -2 });

    expect(markets).toEqual([]);
    const fromStart = await adapter.listMarkets({ limit: 1, skip: -3 });
    expect(fromStart.map((market) => market.id)).toEqual([
      fixtureMarkets[0]!.id,
    ]);
  });

  it("returns one market by id", async () => {
    const adapter = new StubDelphiAdapter();

    const market = await adapter.getMarket({
      id: "0x0000000000000000000000000000000000000002",
    });

    expect(market.metadata?.question).toBe(
      "Will the Meridian Central Bank raise its policy rate above 5% before 1 March 2027?",
    );
    expect(market.category).toBe("economics");
  });

  it("throws a clear not-found error for an unknown market id", async () => {
    const adapter = new StubDelphiAdapter();
    const unknownId = "0x00000000000000000000000000000000000000ff";

    await expect(adapter.getMarket({ id: unknownId })).rejects.toThrow(
      `Market not found: ${unknownId}`,
    );
  });

  it("reports a healthy status", async () => {
    const adapter = new StubDelphiAdapter();

    const result = await adapter.health();

    expect(result.status).toBe("ok");
  });

  it("carries the Vgen19 agent identity", () => {
    const adapter = new StubDelphiAdapter();

    expect(adapter.identity.agentName).toBe("Vgen19");
    expect(adapter.identity.harness).toBe("vgen19");
    expect(adapter.identity.model).toBe("stub");
  });

  it("records the identity sent with each market-list request", async () => {
    const adapter = new StubDelphiAdapter({
      agentName: "Vgen19",
      harness: "vgen19",
      model: "stub",
    });

    await adapter.listMarkets();
    await adapter.listMarkets();

    expect(adapter.recordedRequests).toHaveLength(2);
    expect(adapter.recordedRequests[0]).toEqual({
      agentName: "Vgen19",
      harness: "vgen19",
      model: "stub",
    });
  });

  it("returns a fresh deep copy of the fixtures on each call", async () => {
    const adapter = new StubDelphiAdapter();

    const first = await adapter.listMarkets();
    first[0]!.metadata!.question = "mutated";
    first[0]!.competition!.oddsYes = 0.99;
    const second = await adapter.listMarkets();

    expect(second[0]!.metadata?.question).not.toBe("mutated");
    expect(second[0]!.competition?.oddsYes).not.toBe(0.99);
  });
});

describe("StubDelphiAdapter submitEvidence", () => {
  const draft: EvidenceDraft = {
    createdAt: "2026-11-20T16:00:00.000Z",
    files: [],
    id: "draft-1",
    links: [{ title: "Zanara election date set", url: "https://example.com/zanara" }],
    marketId: "0x0000000000000000000000000000000000000001",
    note: "Zanara set its general election for 15 December 2026.",
    status: "approved",
  };

  it("returns a canned receipt that parses strictly", async () => {
    const adapter = new StubDelphiAdapter();

    const raw = await adapter.submitEvidence(draft, {
      agentName: "Vgen19",
      harness: "vgen19",
      model: "gemini-3.8-flash",
    });

    const receipt = parseSubmissionReceipt(raw);
    expect(receipt.verdict).toBe("accepted");
    expect(receipt.draftId).toBe("draft-1");
    expect(receipt.marketId).toBe(draft.marketId);
    expect(receipt.submissionId).toMatch(/^stub-submission-/);
    expect(receipt.rationale).toContain("Stub receipt");
  });

  it("records the draft and the identity sent with each submission", async () => {
    const adapter = new StubDelphiAdapter();
    const meta = {
      agentName: "Vgen19",
      harness: "vgen19",
      model: "gemini-3.8-flash",
    };

    await adapter.submitEvidence(draft, meta);
    await adapter.submitEvidence({ ...draft, id: "draft-2" }, meta);

    expect(adapter.recordedSubmissions).toHaveLength(2);
    expect(adapter.recordedSubmissions[0]).toEqual({ draft, meta });
    expect(adapter.recordedSubmissions[1]!.draft.id).toBe("draft-2");
    expect(adapter.recordedSubmissions[1]!.meta.model).toBe(
      "gemini-3.8-flash",
    );
  });

  it("assigns a distinct submission id to each canned receipt", async () => {
    const adapter = new StubDelphiAdapter();
    const meta = {
      agentName: "Vgen19",
      harness: "vgen19",
      model: "gemini-3.8-flash",
    };

    const first = parseSubmissionReceipt(
      await adapter.submitEvidence(draft, meta),
    );
    const second = parseSubmissionReceipt(
      await adapter.submitEvidence(draft, meta),
    );

    expect(first.submissionId).not.toBe(second.submissionId);
  });
});

describe("createDelphiAdapter", () => {
  it("returns the stub when no key is configured", () => {
    const adapter = createDelphiAdapter();

    expect(adapter).toBeInstanceOf(StubDelphiAdapter);
    expect(adapter.identity.model).toBe("stub");
  });

  it("returns the stub for a blank key", () => {
    const adapter = createDelphiAdapter(undefined, { apiKey: "   " });

    expect(adapter).toBeInstanceOf(StubDelphiAdapter);
  });

  it("returns the live client when a key is configured", () => {
    const adapter = createDelphiAdapter(undefined, {
      apiKey: "test-delphi-key",
    });

    expect(adapter).toBeInstanceOf(LiveDelphiAdapter);
    expect(adapter.identity.agentName).toBe("Vgen19");
  });

  it("lists markets from the public markets.json with no API key", async () => {
    const seen: Array<{ headers: Headers; url: string }> = [];
    const fetchFn = (async (
      _input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      seen.push({
        headers: new Headers(init?.headers),
        url: typeof _input === "string" ? _input : _input.toString(),
      });
      return new Response(
        JSON.stringify([
          {
            address: "0x94dbba7c9b44b788a701602ab6d919ff7b7fc38a",
            category: "votes_government",
            closesAt: "2026-11-29T06:00:00.000Z",
            delphiUrl:
              "https://delphi.fyi/market/0x94dbba7c9b44b788a701602ab6d919ff7b7fc38a",
            evidenceCutoffAt: "2026-11-28T06:00:00.000Z",
            marketTier: "A",
            odds: { no: 0.483944, yes: 0.516056 },
            pots: { judgement: "20000000", settlement: "30000000" },
            question:
              "Will turnout in Switzerland's federal vote of Nov 29, 2026 be at least 50.0%?",
            resolutionCriteria:
              "The Federal Chancellery's official turnout figure.",
            status: "open",
            wave: 1,
          },
        ]),
        {
          headers: { "Content-Type": "application/json" },
          status: 200,
        },
      );
    }) as unknown as typeof fetch;
    const adapter = createDelphiAdapter(undefined, {
      apiKey: "test-delphi-key",
      fetch: fetchFn,
    });

    const markets = await adapter.listMarkets();

    expect(markets).toHaveLength(1);
    expect(markets[0]!.competition?.rewardPot).toBe(50);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe(
      "https://competition.delphi.fyi/markets.json",
    );
    expect(seen[0]!.headers.get("Authorization")).toBeNull();
    expect(seen[0]!.headers.get("X-API-Key")).toBeNull();
  });

  it("keeps the explicit identity on the live client", () => {
    const adapter = createDelphiAdapter(
      { agentName: "Vgen19", harness: "vgen19", model: "gemini-3.8-flash" },
      { apiKey: "test-delphi-key" },
    );

    expect(adapter.identity.model).toBe("gemini-3.8-flash");
  });
});
