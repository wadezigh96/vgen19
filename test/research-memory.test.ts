import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { fixtureMarkets } from "../src/delphi/fixtures.js";
import { MemoryStore } from "../src/memory/store.js";
import {
  normalizeClaim,
  type KnownFact,
  type ResearchNotes,
} from "../src/research/index.js";

let tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vgen19-research-memory-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { force: true, recursive: true });
  }
  tempDirs = [];
});

const MARKET_ID = fixtureMarkets[0]!.id;

function knownFact(claim: string, sourceUrl: string): KnownFact {
  return {
    claim,
    normalizedClaim: normalizeClaim(claim),
    recordedAt: "2026-11-20T10:00:00.000Z",
    sourceUrl,
  };
}

const NOTES: ResearchNotes = {
  compacted: false,
  fetchedAt: "2026-11-20T10:00:00.000Z",
  findings: [
    {
      claim: "The Zanara Election Commission announced an election.",
      date: "2025-03-11",
      sourceUrl: "https://example.invalid/news/zanara-election",
    },
  ],
  failedSources: [],
  marketId: MARKET_ID,
  question:
    "Will the Republic of Zanara hold a general election before 31 December 2026?",
};

describe("MemoryStore known facts", () => {
  it("loads an empty list when no facts were recorded yet", async () => {
    const store = new MemoryStore(await makeTempDir());

    expect(await store.loadKnownFacts(MARKET_ID)).toEqual([]);
  });

  it("persists known facts per market across store instances", async () => {
    const dataDir = await makeTempDir();
    const writer = new MemoryStore(dataDir);
    const fact = knownFact(
      "The Zanara Election Commission announced an election.",
      "https://example.invalid/news/zanara-election",
    );
    await writer.addKnownFacts(MARKET_ID, [fact]);

    const reader = new MemoryStore(dataDir);
    expect(await reader.loadKnownFacts(MARKET_ID)).toEqual([fact]);
    // Facts are per market: another market sees none of them.
    expect(await reader.loadKnownFacts(fixtureMarkets[1]!.id)).toEqual([]);
  });

  it("stores the same fact only once, however it was worded", async () => {
    const dataDir = await makeTempDir();
    const store = new MemoryStore(dataDir);
    const url = "https://example.invalid/news/zanara-election";

    await store.addKnownFacts(MARKET_ID, [
      knownFact("The Election Was Announced.", url),
    ]);
    await store.addKnownFacts(MARKET_ID, [
      knownFact("  the   election was announced. ", url),
    ]);

    expect(await store.loadKnownFacts(MARKET_ID)).toHaveLength(1);
  });

  it("keeps the same claim from a different source as a separate fact", async () => {
    const dataDir = await makeTempDir();
    const store = new MemoryStore(dataDir);

    await store.addKnownFacts(MARKET_ID, [
      knownFact("The election was announced.", "https://example.invalid/a"),
      knownFact("The election was announced.", "https://example.invalid/b"),
    ]);

    expect(await store.loadKnownFacts(MARKET_ID)).toHaveLength(2);
  });
});

describe("MemoryStore research notes", () => {
  it("loads undefined when no notes were stored yet", async () => {
    const store = new MemoryStore(await makeTempDir());

    expect(await store.loadResearchNotes(MARKET_ID)).toBeUndefined();
  });

  it("persists the latest notes per market across store instances", async () => {
    const dataDir = await makeTempDir();
    const writer = new MemoryStore(dataDir);
    await writer.saveResearchNotes(NOTES);

    const reader = new MemoryStore(dataDir);
    expect(await reader.loadResearchNotes(MARKET_ID)).toEqual(NOTES);
    expect(
      await reader.loadResearchNotes(fixtureMarkets[1]!.id),
    ).toBeUndefined();
  });

  it("re-saving notes for a market replaces the previous notes", async () => {
    const dataDir = await makeTempDir();
    const store = new MemoryStore(dataDir);
    await store.saveResearchNotes(NOTES);

    const updated: ResearchNotes = {
      ...NOTES,
      compacted: true,
      findings: [],
    };
    await store.saveResearchNotes(updated);

    expect(await store.loadResearchNotes(MARKET_ID)).toEqual(updated);
  });
});
