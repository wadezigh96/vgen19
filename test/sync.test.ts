import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { DelphiAdapter } from "../src/delphi/adapter.js";
import { fixtureMarkets } from "../src/delphi/fixtures.js";
import { STUB_IDENTITY } from "../src/delphi/stub.js";
import { syncMarkets } from "../src/delphi/sync.js";
import type { Market } from "../src/delphi/types.js";
import { MemoryStore } from "../src/memory/store.js";

let tempDirs: string[] = [];

async function makeStore(): Promise<MemoryStore> {
  const dir = await mkdtemp(join(tmpdir(), "vgen19-sync-test-"));
  tempDirs.push(dir);
  return new MemoryStore(dir);
}

afterEach(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { force: true, recursive: true });
  }
  tempDirs = [];
});

/** Fake adapter whose market list the test controls between syncs. */
function fakeAdapter(markets: Market[]): DelphiAdapter & {
  setMarkets(next: Market[]): void;
} {
  let current = markets;
  return {
    identity: STUB_IDENTITY,
    async getMarket(params: { id: string }) {
      const market = current.find((candidate) => candidate.id === params.id);
      if (market === undefined) {
        throw new Error(`Market not found: ${params.id}`);
      }
      return structuredClone(market);
    },
    async health() {
      return { status: "ok" };
    },
    async listMarkets() {
      return structuredClone(current);
    },
    async submitEvidence() {
      throw new Error("submitEvidence is not part of the market sync fake.");
    },
    setMarkets(next: Market[]) {
      current = next;
    },
  };
}

/** Fake adapter that honors skip/limit pagination over its list. */
function paginatingAdapter(markets: Market[]): DelphiAdapter {
  return {
    identity: STUB_IDENTITY,
    async getMarket(params: { id: string }) {
      const market = markets.find((candidate) => candidate.id === params.id);
      if (market === undefined) {
        throw new Error(`Market not found: ${params.id}`);
      }
      return structuredClone(market);
    },
    async health() {
      return { status: "ok" };
    },
    async listMarkets(params: { limit?: number; skip?: number } = {}) {
      const skip = Math.max(0, params.skip ?? 0);
      // The API's default page is 50 when no limit is given.
      const limit = params.limit ?? 50;
      return structuredClone(markets.slice(skip, skip + limit));
    },
    async submitEvidence() {
      throw new Error("submitEvidence is not part of the market sync fake.");
    },
  };
}

/** Recursively reverse key order at every level, keeping values equal. */
function reverseKeys<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => reverseKeys(item)) as T;
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([key, entry]) => [key, reverseKeys(entry)]),
    ) as T;
  }
  return value;
}

describe("syncMarkets", () => {
  it("stores the markets fetched from the adapter", async () => {
    const store = await makeStore();
    const adapter = fakeAdapter(fixtureMarkets);

    const result = await syncMarkets(adapter, store);

    expect(result.added).toBe(fixtureMarkets.length);
    expect(result.updated).toBe(0);
    expect(result.markets).toEqual(fixtureMarkets);
    expect(await store.loadMarkets()).toEqual(fixtureMarkets);
  });

  it("re-syncing updates a changed market without duplicating", async () => {
    const store = await makeStore();
    const adapter = fakeAdapter(fixtureMarkets);
    await syncMarkets(adapter, store);

    const moved = {
      ...fixtureMarkets[0]!,
      competition: {
        ...fixtureMarkets[0]!.competition,
        oddsNo: 0.2,
        oddsYes: 0.8,
      },
    };
    adapter.setMarkets([moved, ...fixtureMarkets.slice(1)]);

    const result = await syncMarkets(adapter, store);

    expect(result.added).toBe(0);
    expect(result.updated).toBe(1);
    const stored = await store.loadMarkets();
    expect(stored).toHaveLength(fixtureMarkets.length);
    expect(stored.find((m) => m.id === moved.id)).toEqual(moved);
  });

  it("re-syncing unchanged markets reports no additions or updates", async () => {
    const store = await makeStore();
    const adapter = fakeAdapter(fixtureMarkets);
    await syncMarkets(adapter, store);

    const result = await syncMarkets(adapter, store);

    expect(result.added).toBe(0);
    expect(result.updated).toBe(0);
    expect(await store.loadMarkets()).toHaveLength(fixtureMarkets.length);
  });

  it("syncs a market without the competition extension", async () => {
    const store = await makeStore();
    const withoutCompetition = structuredClone(fixtureMarkets[0]!);
    delete withoutCompetition.competition;
    const adapter = fakeAdapter([withoutCompetition]);

    const result = await syncMarkets(adapter, store);

    expect(result.added).toBe(1);
    expect(result.markets).toEqual([withoutCompetition]);
    const stored = await store.loadMarkets();
    expect(stored).toHaveLength(1);
    expect(stored[0]!.competition).toBeUndefined();
  });

  it("counts a newly opened market as added", async () => {
    const store = await makeStore();
    const adapter = fakeAdapter(fixtureMarkets.slice(0, 2));
    await syncMarkets(adapter, store);

    adapter.setMarkets(fixtureMarkets);
    const result = await syncMarkets(adapter, store);

    expect(result.added).toBe(fixtureMarkets.length - 2);
    expect(result.updated).toBe(0);
  });

  it("pages through a list larger than one page", async () => {
    const store = await makeStore();
    const many = Array.from({ length: 125 }, (_, index) => ({
      ...structuredClone(fixtureMarkets[0]!),
      id: `0x${String(index + 1).padStart(40, "0")}`,
    }));
    const adapter = paginatingAdapter(many);

    const result = await syncMarkets(adapter, store);

    expect(result.added).toBe(125);
    expect(result.markets).toHaveLength(125);
    expect(await store.loadMarkets()).toHaveLength(125);
  });

  it("terminates when the adapter ignores pagination parameters", async () => {
    const store = await makeStore();
    // This fake ignores skip/limit and returns all 60 markets on
    // every call; sync must still terminate, deduped by id.
    const many = Array.from({ length: 60 }, (_, index) => ({
      ...structuredClone(fixtureMarkets[0]!),
      id: `0x${String(index + 1).padStart(40, "0")}`,
    }));
    const adapter = fakeAdapter(many);

    const result = await syncMarkets(adapter, store);

    expect(result.added).toBe(60);
    expect(result.markets).toHaveLength(60);
  });

  it("does not count a reordered-but-identical market as updated", async () => {
    const store = await makeStore();
    const adapter = fakeAdapter(fixtureMarkets);
    await syncMarkets(adapter, store);

    const reordered = reverseKeys(fixtureMarkets[0]!);
    adapter.setMarkets([reordered, ...fixtureMarkets.slice(1)]);

    const result = await syncMarkets(adapter, store);

    expect(result.added).toBe(0);
    expect(result.updated).toBe(0);
  });
});
