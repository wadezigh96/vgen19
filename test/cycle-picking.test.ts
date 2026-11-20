import { describe, expect, it } from "vitest";

import { fixtureMarkets } from "../src/delphi/fixtures.js";
import type { Market } from "../src/delphi/types.js";
import {
  DEFAULT_MAX_MARKETS_PER_CYCLE,
  pickMarkets,
} from "../src/cycle/picking.js";

const OPEN = fixtureMarkets.filter((market) => market.status === "open");
const SETTLED = fixtureMarkets.find(
  (market) => market.status === "awaiting_settlement",
)!;

// All fixture cutoffs are in the future relative to this date.
const NOW = new Date("2026-11-20T00:00:00.000Z");

function marketWithId(id: string): Market {
  const found = fixtureMarkets.find((market) => market.id === id);
  if (found === undefined) {
    throw new Error(`unknown fixture market ${id}`);
  }
  return found;
}

describe("pickMarkets", () => {
  it("picks open markets in sync order and skips non-open ones", () => {
    const result = pickMarkets(fixtureMarkets, {
      now: NOW,
      previouslyStoredIds: new Set(),
      submissionsByMarket: {},
    });

    expect(result.picked.map((market) => market.id)).toEqual(
      OPEN.map((market) => market.id),
    );
    expect(result.skipped).toEqual([
      { market: SETTLED, reason: "not-open" },
    ]);
  });

  it("prefers newly opened markets over markets seen in a previous cycle", () => {
    const seen = new Set([OPEN[0]!.id, OPEN[1]!.id]);
    const result = pickMarkets(fixtureMarkets, {
      now: NOW,
      previouslyStoredIds: seen,
      submissionsByMarket: {},
    });

    expect(result.picked.map((market) => market.id)).toEqual([
      OPEN[2]!.id,
      OPEN[3]!.id,
      OPEN[0]!.id,
      OPEN[1]!.id,
    ]);
  });

  it("prefers markets with fewer submissions so far", () => {
    const result = pickMarkets(fixtureMarkets, {
      now: NOW,
      previouslyStoredIds: new Set(),
      submissionsByMarket: {
        [OPEN[0]!.id]: 2,
        [OPEN[1]!.id]: 1,
      },
    });

    expect(result.picked.map((market) => market.id)).toEqual([
      OPEN[2]!.id,
      OPEN[3]!.id,
      OPEN[1]!.id,
      OPEN[0]!.id,
    ]);
  });

  it("skips fully covered markets (3 submissions already recorded)", () => {
    const covered = OPEN[1]!;
    const result = pickMarkets(fixtureMarkets, {
      now: NOW,
      previouslyStoredIds: new Set(),
      submissionsByMarket: { [covered.id]: 3 },
    });

    expect(result.picked.map((market) => market.id)).not.toContain(
      covered.id,
    );
    expect(result.skipped).toContainEqual({
      market: covered,
      reason: "fully-covered",
    });
  });

  it("caps the number of targets per cycle (default 5)", () => {
    expect(DEFAULT_MAX_MARKETS_PER_CYCLE).toBe(5);

    const result = pickMarkets(fixtureMarkets, {
      maxMarkets: 2,
      now: NOW,
      previouslyStoredIds: new Set(),
      submissionsByMarket: {},
    });

    expect(result.picked.map((market) => market.id)).toEqual([
      OPEN[0]!.id,
      OPEN[1]!.id,
    ]);
    expect(result.skipped).toContainEqual({
      market: OPEN[2]!,
      reason: "over-cap",
    });
    expect(result.skipped).toContainEqual({
      market: OPEN[3]!,
      reason: "over-cap",
    });
  });

  it("is deterministic: the same input always picks the same order", () => {
    const options = {
      now: NOW,
      previouslyStoredIds: new Set([OPEN[0]!.id]),
      submissionsByMarket: { [OPEN[2]!.id]: 1 },
    };
    const first = pickMarkets(fixtureMarkets, options);
    const second = pickMarkets(fixtureMarkets, options);

    expect(second.picked.map((market) => market.id)).toEqual(
      first.picked.map((market) => market.id),
    );
    expect(second.skipped.map((entry) => entry.market.id)).toEqual(
      first.skipped.map((entry) => entry.market.id),
    );
  });

  it("skips a market whose evidence cutoff has passed", () => {
    const pastCutoff = {
      ...OPEN[0]!,
      competition: {
        ...OPEN[0]!.competition,
        evidenceCutoff: "2026-11-01T00:00:00.000Z",
      },
    };
    const result = pickMarkets([pastCutoff, ...fixtureMarkets.slice(1)], {
      now: NOW,
      previouslyStoredIds: new Set(),
      submissionsByMarket: {},
    });

    expect(result.picked.map((market) => market.id)).not.toContain(
      OPEN[0]!.id,
    );
    expect(result.skipped).toContainEqual({
      market: pastCutoff,
      reason: "past-cutoff",
    });
  });

  it("still picks a market with no evidence cutoff", () => {
    // No competition extension at all: no cutoff to enforce.
    const noCutoff = { ...OPEN[0]! };
    delete noCutoff.competition;
    const result = pickMarkets([noCutoff, ...fixtureMarkets.slice(1)], {
      now: NOW,
      previouslyStoredIds: new Set(),
      submissionsByMarket: {},
    });

    expect(result.picked.map((market) => market.id)).toContain(OPEN[0]!.id);
  });

  it("picks nothing when every synced market is skipped", () => {
    const result = pickMarkets([SETTLED, marketWithId(OPEN[0]!.id)], {
      now: NOW,
      previouslyStoredIds: new Set(),
      submissionsByMarket: { [OPEN[0]!.id]: 3 },
    });

    expect(result.picked).toEqual([]);
    expect(result.skipped).toHaveLength(2);
  });
});
