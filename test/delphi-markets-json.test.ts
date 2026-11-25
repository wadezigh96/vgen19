import { describe, expect, it } from "vitest";

import {
  DELPHI_MARKETS_JSON_URL,
  fetchMarketsJson,
  parseMarketsJson,
} from "../src/delphi/markets-json.js";

/** One entry exactly as the public markets.json returns it. */
function jsonEntry(overrides: Record<string, unknown> = {}) {
  return {
    address: "0x94dbba7c9b44b788a701602ab6d919ff7b7fc38a",
    category: "votes_government",
    categoryLabel: "Votes and government",
    closesAt: "2026-11-29T06:00:00.000Z",
    dataSources: ["https://www.bk.admin.ch", "https://opendata.swiss"],
    delphiUrl:
      "https://delphi.fyi/market/0x94dbba7c9b44b788a701602ab6d919ff7b7fc38a",
    evidenceCutoffAt: "2026-11-28T06:00:00.000Z",
    marketTier: "A",
    odds: { no: 0.483944, yes: 0.516056 },
    pots: { judgement: "20000000", settlement: "30000000" },
    question:
      "Will turnout in Switzerland's federal vote of Nov 29, 2026 be at least 50.0%, per the Federal Chancellery?",
    resolutionCriteria:
      "Resolution criteria:\n- \"Yes, >=50.0%\": Wins if the Federal Chancellery's official turnout figure is 50.0% or higher.",
    settled: null,
    status: "open",
    wave: 1,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    status,
  });
}

describe("parseMarketsJson", () => {
  it("maps a sample entry to a Market with the competition extension", () => {
    const markets = parseMarketsJson([jsonEntry()]);

    expect(markets).toHaveLength(1);
    const market = markets[0]!;
    expect(market.id).toBe(
      "0x94dbba7c9b44b788a701602ab6d919ff7b7fc38a",
    );
    expect(market.marketUrl).toBe(
      "https://delphi.fyi/market/0x94dbba7c9b44b788a701602ab6d919ff7b7fc38a",
    );
    expect(market.status).toBe("open");
    expect(market.category).toBe("votes_government");
    expect(market.metadata?.question).toBe(
      "Will turnout in Switzerland's federal vote of Nov 29, 2026 be at least 50.0%, per the Federal Chancellery?",
    );
    expect(market.metadata?.resolutionCriteria).toContain(
      "Resolution criteria:",
    );
    expect(market.metadata?.endDate).toBe("2026-11-29T06:00:00.000Z");
    expect(market.dataSources).toEqual([
      "https://www.bk.admin.ch",
      "https://opendata.swiss",
    ]);
    expect(market.competition?.oddsYes).toBe(0.516056);
    expect(market.competition?.oddsNo).toBe(0.483944);
    expect(market.competition?.judgementPot).toBe(20);
    expect(market.competition?.settlementPot).toBe(30);
    expect(market.competition?.rewardPot).toBe(50);
    expect(market.competition?.evidenceCutoff).toBe(
      "2026-11-28T06:00:00.000Z",
    );
    expect(market.competition?.tier).toBe("A");
    expect(market.competition?.wave).toBe(1);
  });

  it("maps a tier B entry", () => {
    const markets = parseMarketsJson([
      jsonEntry({
        address: "0xbb2666746de61bb1b119398f4db48a53d64e20cd",
        category: "local_language",
        delphiUrl:
          "https://delphi.fyi/market/0xbb2666746de61bb1b119398f4db48a53d64e20cd",
        marketTier: "B",
        odds: { no: 0.333736, yes: 0.666264 },
      }),
    ]);

    expect(markets).toHaveLength(1);
    expect(markets[0]!.competition?.tier).toBe("B");
    expect(markets[0]!.category).toBe("local_language");
    expect(markets[0]!.competition?.oddsYes).toBe(0.666264);
  });

  it("skips entries whose status is not open", () => {
    const markets = parseMarketsJson([
      jsonEntry(),
      jsonEntry({ address: "0xsettled", status: "settled" }),
      jsonEntry({ address: "0xawaiting", status: "awaiting_settlement" }),
      jsonEntry({ address: "0xmystery", status: "mystery" }),
    ]);

    expect(markets).toHaveLength(1);
    expect(markets[0]!.id).toBe(
      "0x94dbba7c9b44b788a701602ab6d919ff7b7fc38a",
    );
  });

  it("builds marketUrl from the address when delphiUrl is missing", () => {
    const entry = jsonEntry();
    delete (entry as Record<string, unknown>)["delphiUrl"];

    const markets = parseMarketsJson([entry]);

    expect(markets[0]!.marketUrl).toBe(
      "https://delphi.fyi/market/0x94dbba7c9b44b788a701602ab6d919ff7b7fc38a",
    );
  });

  it("fails loudly when an entry is missing its address", () => {
    const entry = jsonEntry();
    delete (entry as Record<string, unknown>)["address"];

    expect(() => parseMarketsJson([entry])).toThrow(/address/i);
  });

  it("fails loudly when an entry is missing its question", () => {
    const entry = jsonEntry();
    delete (entry as Record<string, unknown>)["question"];

    expect(() => parseMarketsJson([entry])).toThrow(/question/i);
  });

  it("fails loudly when the top level is not a list", () => {
    expect(() => parseMarketsJson({ markets: [jsonEntry()] })).toThrow(
      /malformed/i,
    );
  });

  it("fails loudly on malformed odds", () => {
    expect(() =>
      parseMarketsJson([jsonEntry({ odds: { no: 0.5, yes: "high" } })]),
    ).toThrow(/odds/i);
  });

  it("fails loudly on malformed pots", () => {
    expect(() =>
      parseMarketsJson([
        jsonEntry({ pots: { judgement: "twenty", settlement: "30000000" } }),
      ]),
    ).toThrow(/pot/i);
  });

  it("leaves the competition pots undefined when pots are absent", () => {
    const entry = jsonEntry();
    delete (entry as Record<string, unknown>)["pots"];

    const markets = parseMarketsJson([entry]);

    expect(markets[0]!.competition?.judgementPot).toBeUndefined();
    expect(markets[0]!.competition?.settlementPot).toBeUndefined();
    expect(markets[0]!.competition?.rewardPot).toBeUndefined();
    expect(markets[0]!.competition?.oddsYes).toBe(0.516056);
  });
});

describe("fetchMarketsJson", () => {
  it("fetches the public list with no authentication headers", async () => {
    const seen: Array<{ headers: Headers; url: string }> = [];
    const fetchFn = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      seen.push({
        headers: new Headers(init?.headers),
        url: typeof input === "string" ? input : input.toString(),
      });
      return jsonResponse([jsonEntry()]);
    }) as unknown as typeof fetch;

    const markets = await fetchMarketsJson(fetchFn);

    expect(markets).toHaveLength(1);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe(DELPHI_MARKETS_JSON_URL);
    expect(seen[0]!.headers.get("Authorization")).toBeNull();
    expect(seen[0]!.headers.get("X-API-Key")).toBeNull();
    expect(seen[0]!.headers.get("Accept")).toBe("application/json");
  });

  it("fails loudly when the fetch returns a non-OK status", async () => {
    const fetchFn = (async (): Promise<Response> =>
      new Response("bad gateway", { status: 502 })) as unknown as typeof fetch;

    const error = await fetchMarketsJson(fetchFn).catch(
      (caught: unknown) => caught,
    );
    expect((error as Error).message).toMatch(/502/);
    expect((error as Error).message).toContain(DELPHI_MARKETS_JSON_URL);
  });

  it("fails loudly on a non-JSON response", async () => {
    const fetchFn = (async (): Promise<Response> =>
      new Response("this is not json", { status: 200 })) as unknown as typeof fetch;

    await expect(fetchMarketsJson(fetchFn)).rejects.toThrow(/not JSON/i);
  });

  it("fails loudly when the network itself fails", async () => {
    const fetchFn = (async (): Promise<Response> => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;

    await expect(fetchMarketsJson(fetchFn)).rejects.toThrow(
      /markets\.json.*fetch failed|fetch failed/i,
    );
  });
});
