import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { fixtureMarkets } from "../src/delphi/fixtures.js";
import type { EvidenceDraft, ReviewScore } from "../src/draft/index.js";
import { MemoryStore } from "../src/memory/store.js";

let tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vgen19-draft-memory-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { force: true, recursive: true });
  }
  tempDirs = [];
});

const MARKET_A = fixtureMarkets[0]!.id;
const MARKET_B = fixtureMarkets[1]!.id;

const SCORE: ReviewScore = {
  dimensions: {
    dated: { rationale: "The note carries a date.", score: 1 },
    noInventedFacts: { rationale: "Every claim is in the findings.", score: 1 },
    novel: { rationale: "No overlap with known facts.", score: 1 },
    relevant: { rationale: "The note answers the question.", score: 1 },
    sourced: { rationale: "Every link is in the notes.", score: 1 },
  },
  overall: 1,
  passed: true,
  reviewedAt: "2026-11-20T10:05:00.000Z",
  threshold: 0.7,
};

function draft(
  id: string,
  marketId: string,
  overrides: Partial<EvidenceDraft> = {},
): EvidenceDraft {
  return {
    createdAt: "2026-11-20T10:00:00.000Z",
    files: [],
    id,
    links: [{ url: "https://example.invalid/news/zanara-election" }],
    marketId,
    note: "The Zanara Election Commission announced a general election for 31 December 2026 (2025-03-11).",
    status: "draft",
    ...overrides,
  };
}

describe("drafts collection", () => {
  it("saves a draft with its score and loads it back by id", async () => {
    const store = new MemoryStore(await makeTempDir());
    const saved = draft("draft-1", MARKET_A, {
      score: SCORE,
      status: "approved",
    });

    await store.saveDraft(saved);
    const loaded = await store.loadDraft("draft-1");

    expect(loaded).toEqual(saved);
    expect(loaded?.score?.overall).toBe(1);
    expect(loaded?.status).toBe("approved");
  });

  it("returns undefined for an unknown draft id", async () => {
    const store = new MemoryStore(await makeTempDir());

    expect(await store.loadDraft("draft-missing")).toBeUndefined();
  });

  it("keeps drafts append-only: a second draft for the same market never overwrites the first", async () => {
    const store = new MemoryStore(await makeTempDir());
    const first = draft("draft-1", MARKET_A, { status: "rejected" });
    const second = draft("draft-2", MARKET_A, { status: "approved" });

    await store.saveDraft(first);
    await store.saveDraft(second);

    expect(await store.loadDraft("draft-1")).toEqual(first);
    expect(await store.loadDraft("draft-2")).toEqual(second);
    const forMarket = await store.loadDrafts(MARKET_A);
    expect(forMarket).toHaveLength(2);
    expect(forMarket.map((entry) => entry.id)).toEqual([
      "draft-1",
      "draft-2",
    ]);
  });

  it("loads all drafts across markets, and filters by market", async () => {
    const store = new MemoryStore(await makeTempDir());
    await store.saveDraft(draft("draft-1", MARKET_A));
    await store.saveDraft(draft("draft-2", MARKET_B));

    expect(await store.loadDrafts()).toHaveLength(2);
    expect(await store.loadDrafts(MARKET_A)).toHaveLength(1);
    expect(await store.loadDrafts(MARKET_B)).toHaveLength(1);
    expect(await store.loadDrafts("0x00000000000000000000000000000000ff")).toEqual([]);
  });

  it("persists drafts across store instances (a new run can read them)", async () => {
    const dataDir = await makeTempDir();
    const first = new MemoryStore(dataDir);
    await first.saveDraft(
      draft("draft-1", MARKET_A, { score: SCORE, status: "approved" }),
    );

    const second = new MemoryStore(dataDir);
    const loaded = await second.loadDraft("draft-1");

    expect(loaded?.status).toBe("approved");
    expect(loaded?.score?.overall).toBe(1);
  });
});
