import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { fixtureMarkets } from "../src/delphi/fixtures.js";
import { MemoryStore } from "../src/memory/store.js";

let tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vgen19-memory-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { force: true, recursive: true });
  }
  tempDirs = [];
});

describe("MemoryStore markets", () => {
  it("persists markets across store instances (round-trip)", async () => {
    const dataDir = await makeTempDir();

    const writer = new MemoryStore(dataDir);
    await writer.saveMarkets(fixtureMarkets);

    const reader = new MemoryStore(dataDir);
    const loaded = await reader.loadMarkets();

    expect(loaded).toEqual(fixtureMarkets);
  });

  it("creates the data directory when it does not exist yet", async () => {
    const parent = await makeTempDir();
    const dataDir = join(parent, "nested", "data");
    const store = new MemoryStore(dataDir);

    await store.saveMarkets(fixtureMarkets.slice(0, 1));

    const reader = new MemoryStore(dataDir);
    expect(await reader.loadMarkets()).toHaveLength(1);
  });

  it("loads an empty list when nothing was stored yet", async () => {
    const dataDir = await makeTempDir();
    const store = new MemoryStore(dataDir);

    expect(await store.loadMarkets()).toEqual([]);
  });

  it("re-saving a changed market updates it without duplicating", async () => {
    const dataDir = await makeTempDir();
    const store = new MemoryStore(dataDir);
    await store.saveMarkets(fixtureMarkets);

    const moved = {
      ...fixtureMarkets[0]!,
      competition: {
        ...fixtureMarkets[0]!.competition,
        oddsNo: 0.2,
        oddsYes: 0.8,
      },
    };
    await store.saveMarkets([moved]);

    const loaded = await store.loadMarkets();
    expect(loaded).toHaveLength(fixtureMarkets.length);
    expect(loaded.find((m) => m.id === moved.id)).toEqual(moved);
  });

  it("persists a market without the competition extension", async () => {
    const dataDir = await makeTempDir();
    const withoutCompetition = structuredClone(fixtureMarkets[0]!);
    delete withoutCompetition.competition;

    const writer = new MemoryStore(dataDir);
    await writer.saveMarkets([withoutCompetition]);

    const reader = new MemoryStore(dataDir);
    const loaded = await reader.loadMarkets();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toEqual(withoutCompetition);
    expect(loaded[0]!.competition).toBeUndefined();
  });

  it("saving the same markets twice stores each one only once", async () => {
    const dataDir = await makeTempDir();
    const store = new MemoryStore(dataDir);

    await store.saveMarkets(fixtureMarkets);
    await store.saveMarkets(fixtureMarkets);

    expect(await store.loadMarkets()).toHaveLength(fixtureMarkets.length);
  });

  it("stores markets keyed by market id in markets.json", async () => {
    const dataDir = await makeTempDir();
    const store = new MemoryStore(dataDir);
    await store.saveMarkets(fixtureMarkets.slice(0, 2));

    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(join(dataDir, "markets.json"), "utf-8");
    const stored = JSON.parse(raw) as Record<string, unknown>;

    expect(Object.keys(stored).sort()).toEqual([
      "0x0000000000000000000000000000000000000001",
      "0x0000000000000000000000000000000000000002",
    ]);
  });
});
