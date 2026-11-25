/**
 * The competition market list as public JSON.
 *
 * The reads API (`delphi-api.gensyn.ai`) returns HTTP 401
 * `{"error":"invalid API key"}` for `listMarkets` and `getMarket`
 * with the Mainnet key (verified 26 November 2026), so it cannot
 * supply the market list. The official list is the public JSON at
 * `https://competition.delphi.fyi/markets.json` — competition.md
 * v1.0 says it is the same list as the competition grid — so the
 * live client reads its markets from here instead. The file is
 * public and needs no authentication: no API key is sent.
 *
 * The mapping is pure and unit-testable (`parseMarketsJson`); only
 * the fields the agent reasons about are validated — `address` and
 * `question` — so a new JSON field never breaks the sync, but a
 * market missing its identity fails loudly instead of poisoning
 * the store. Entries whose status is not "open" are skipped, not
 * errors: a settled market is a normal list entry, not a failure.
 */

import { baseUnitsToUsdcE } from "./evidence.js";
import type { Market, MarketCompetition } from "./types.js";

/**
 * Public competition market list. competition.md v1.0: the same list
 * as the competition grid at `competition.delphi.fyi/markets`.
 */
export const DELPHI_MARKETS_JSON_URL =
  "https://competition.delphi.fyi/markets.json";

/** Base URL for a market link when an entry carries no `delphiUrl`. */
const DELPHI_MARKET_URL_BASE = "https://delphi.fyi/market";

/** An error reading or parsing the public market list. */
export class MarketsJsonError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = "MarketsJsonError";
  }
}

function requiredString(
  record: Record<string, unknown>,
  key: string,
  what: string,
): string {
  const value = record[key];
  if (typeof value !== "string" || value === "") {
    throw new MarketsJsonError(
      `Delphi markets.json ${what} is missing ${key}.`,
    );
  }
  return value;
}

function optionalString(
  record: Record<string, unknown>,
  key: string,
  what: string,
): string | undefined {
  const value = record[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new MarketsJsonError(
      `Delphi markets.json ${what} has a malformed ${key}: expected a string.`,
    );
  }
  return value;
}

function optionalNumber(
  record: Record<string, unknown>,
  key: string,
  what: string,
): number | undefined {
  const value = record[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new MarketsJsonError(
      `Delphi markets.json ${what} has a malformed ${key}: expected a number.`,
    );
  }
  return value;
}

function parseOdds(
  record: Record<string, unknown>,
  what: string,
): { oddsNo?: number; oddsYes?: number } {
  const odds = record["odds"];
  if (odds === undefined || odds === null) {
    return {};
  }
  if (typeof odds !== "object" || Array.isArray(odds)) {
    throw new MarketsJsonError(
      `Delphi markets.json ${what} has malformed odds: expected an object with yes/no numbers.`,
    );
  }
  const oddsRecord = odds as Record<string, unknown>;
  const oddsYes = optionalNumber(oddsRecord, "yes", `${what} odds`);
  const oddsNo = optionalNumber(oddsRecord, "no", `${what} odds`);
  return { oddsNo, oddsYes };
}

function parsePots(
  record: Record<string, unknown>,
  what: string,
): {
  judgementPot?: number;
  rewardPot?: number;
  settlementPot?: number;
} {
  const pots = record["pots"];
  if (pots === undefined || pots === null) {
    return {};
  }
  if (typeof pots !== "object" || Array.isArray(pots)) {
    throw new MarketsJsonError(
      `Delphi markets.json ${what} has malformed pots: expected an object with judgement/settlement base-unit strings.`,
    );
  }
  const potsRecord = pots as Record<string, unknown>;
  const parsePot = (key: string): number | undefined => {
    const value = potsRecord[key];
    if (value === undefined || value === null) {
      return undefined;
    }
    if (typeof value !== "string") {
      throw new MarketsJsonError(
        `Delphi markets.json ${what} has a malformed ${key} pot: expected a base-unit string.`,
      );
    }
    try {
      return baseUnitsToUsdcE(value);
    } catch {
      throw new MarketsJsonError(
        `Delphi markets.json ${what} has a malformed ${key} pot: "${value}" is not a non-negative integer in USDC.e base units.`,
      );
    }
  };
  const judgementPot = parsePot("judgement");
  const settlementPot = parsePot("settlement");
  const rewardPot =
    judgementPot === undefined && settlementPot === undefined
      ? undefined
      : (judgementPot ?? 0) + (settlementPot ?? 0);
  return { judgementPot, rewardPot, settlementPot };
}

/**
 * Map one markets.json entry to a `Market`, or `null` when the entry
 * is not an open market (settled, expired, or unknown status).
 */
function parseMarketsJsonEntry(
  value: unknown,
  index: number,
): Market | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new MarketsJsonError(
      `Delphi markets.json entry ${index} is not an object.`,
    );
  }
  const record = value as Record<string, unknown>;
  if (record["status"] !== "open") {
    return null;
  }
  const what = `entry ${index}`;
  const address = requiredString(record, "address", what);
  const marketWhat = `market ${address}`;
  const question = requiredString(record, "question", marketWhat);
  const closesAt = optionalString(record, "closesAt", marketWhat);
  const evidenceCutoffAt = optionalString(
    record,
    "evidenceCutoffAt",
    marketWhat,
  );
  const category = optionalString(record, "category", marketWhat) ?? "";
  const resolutionCriteria = optionalString(
    record,
    "resolutionCriteria",
    marketWhat,
  );
  const delphiUrl = optionalString(record, "delphiUrl", marketWhat);
  const { oddsNo, oddsYes } = parseOdds(record, marketWhat);
  const { judgementPot, rewardPot, settlementPot } = parsePots(
    record,
    marketWhat,
  );
  const tierRaw = record["marketTier"];
  const tier =
    tierRaw === "A" || tierRaw === "B" ? tierRaw : undefined;
  const wave = optionalNumber(record, "wave", marketWhat);
  const dataSources = Array.isArray(record["dataSources"])
    ? record["dataSources"]
    : [];
  const settledAt = optionalString(record, "settled", marketWhat);

  const competition: MarketCompetition = {
    ...(oddsYes !== undefined ? { oddsYes } : {}),
    ...(oddsNo !== undefined ? { oddsNo } : {}),
    ...(rewardPot !== undefined ? { rewardPot } : {}),
    ...(judgementPot !== undefined ? { judgementPot } : {}),
    ...(settlementPot !== undefined ? { settlementPot } : {}),
    ...(evidenceCutoffAt !== undefined
      ? { evidenceCutoff: evidenceCutoffAt }
      : {}),
    ...(tier !== undefined ? { tier } : {}),
    ...(wave !== undefined ? { wave } : {}),
  };
  const hasCompetition = Object.keys(competition).length > 0;

  return {
    // markets.json carries no app UUID: the contract address is the
    // market's identity on the competition site, so it stands in for
    // both ids. The link comes from the entry itself.
    appMarketId: address,
    category,
    createdAt: "",
    dataSources,
    deployer: "",
    error: null,
    fetchedAt: null,
    fetchResponseStatus: null,
    id: address,
    implementation: "",
    marketUrl: delphiUrl ?? `${DELPHI_MARKET_URL_BASE}/${address}`,
    metadata: {
      ...(category === "" ? {} : { category }),
      ...(closesAt !== undefined ? { endDate: closesAt } : {}),
      question,
      ...(resolutionCriteria !== undefined ? { resolutionCriteria } : {}),
    },
    metadataUri: "",
    metadataUriContentHash: "",
    proof: null,
    resolvesAt: null,
    settledAt: settledAt ?? null,
    settlesAt: null,
    status: "open",
    tradingFee: null,
    // markets.json does not state verifiability.
    verifiable: false,
    winningOutcomeIdx: null,
    ...(hasCompetition ? { competition } : {}),
  };
}

/**
 * Parse the markets.json document into open `Market`s. The top level
 * must be a list; entries whose status is not "open" are skipped.
 */
export function parseMarketsJson(value: unknown): Market[] {
  if (!Array.isArray(value)) {
    throw new MarketsJsonError(
      "Delphi markets.json returned a malformed response: expected a list of markets.",
    );
  }
  const markets: Market[] = [];
  for (const [index, entry] of value.entries()) {
    const market = parseMarketsJsonEntry(entry, index);
    if (market !== null) {
      markets.push(market);
    }
  }
  return markets;
}

/**
 * Fetch the public market list and parse it. Sends no authentication:
 * the file is public. `url` is overridable for tests.
 */
export async function fetchMarketsJson(
  fetchFn: typeof fetch,
  url: string = DELPHI_MARKETS_JSON_URL,
): Promise<Market[]> {
  let response: Response;
  try {
    response = await fetchFn(url, {
      headers: { Accept: "application/json" },
      method: "GET",
    });
  } catch (error) {
    throw new MarketsJsonError(
      `Delphi markets.json fetch failed for ${url}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const text = await response.text();
  if (!response.ok) {
    throw new MarketsJsonError(
      `Delphi markets.json request failed (${response.status}) for ${url}: ${text.slice(0, 200)}`,
      response.status,
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new MarketsJsonError(
      `Delphi markets.json returned a response that is not JSON for ${url}: ${text.slice(0, 200)}`,
    );
  }
  return parseMarketsJson(json);
}
