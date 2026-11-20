import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import type { EvidenceDraft } from "../src/draft/types.js";
import { FakeModelProvider } from "../src/llm/fake.js";
import { RoutedModelClient } from "../src/llm/client.js";
import { MemoryStore } from "../src/memory/store.js";
import { reviewDraft } from "../src/draft/review.js";
import type { ResearchNotes } from "../src/research/notes.js";

const FIXTURE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "golden-markets.json",
);

let tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vgen19-golden-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { force: true, recursive: true });
  }
  tempDirs = [];
});

interface GoldenFinding {
  claim: string;
  date: string;
  sourceTitle: string;
  sourceUrl: string;
}

interface GoldenMarket {
  id: string;
  question: string;
  outcome: string;
  findings: GoldenFinding[];
  draft: {
    note: string;
    links: Array<{ title: string; url: string }>;
  };
}

interface GoldenSet {
  version: number;
  markets: GoldenMarket[];
}

async function loadGoldenSet(): Promise<GoldenSet> {
  const raw = await readFile(FIXTURE_PATH, "utf-8");
  const parsed = JSON.parse(raw) as GoldenSet;
  if (!Array.isArray(parsed.markets) || parsed.markets.length < 3) {
    throw new Error("Golden set must hold at least 3 markets.");
  }
  return parsed;
}

function routedClient(fake: FakeModelProvider): RoutedModelClient {
  return new RoutedModelClient({
    models: { primary: { fast: "fake-fast", strong: "fake-strong" } },
    primary: fake,
  });
}

const STRONG_JUDGMENT = JSON.stringify({
  noInventedFacts: {
    rationale: "Judge: every claim is supported by the findings.",
    score: 1,
  },
  novel: { rationale: "Judge: the facts are new.", score: 1 },
  relevant: { rationale: "Judge: the note answers the question.", score: 1 },
  sourced: { rationale: "Judge: the claims cite their links.", score: 1 },
});

function notesFor(market: GoldenMarket): ResearchNotes {
  return {
    compacted: false,
    failedSources: [],
    fetchedAt: "2026-11-20T09:00:00.000Z",
    findings: market.findings,
    marketId: market.id,
    question: market.question,
  };
}

function draftFor(market: GoldenMarket): EvidenceDraft {
  return {
    createdAt: "2026-11-20T10:00:00.000Z",
    files: [],
    id: `golden-${market.id.slice(-4)}`,
    links: market.draft.links,
    marketId: market.id,
    note: market.draft.note,
    status: "draft",
  };
}

describe("golden eval set", () => {
  it("passes every golden market's draft under the same rubric as the judge", async () => {
    const golden = await loadGoldenSet();
    const store = new MemoryStore(await makeTempDir());

    for (const market of golden.markets) {
      const fake = new FakeModelProvider({
        script: [{ text: STRONG_JUDGMENT }],
      });
      const score = await reviewDraft(
        draftFor(market),
        notesFor(market),
        routedClient(fake),
        store,
      );

      expect(
        score.passed,
        `Golden market ${market.id} (${market.outcome}) should pass: ` +
          `overall ${score.overall}, dimensions ` +
          JSON.stringify(score.dimensions),
      ).toBe(true);
    }
  });

  it("fails a golden draft that cites a link outside its notes", async () => {
    const golden = await loadGoldenSet();
    const market = golden.markets[0]!;
    const store = new MemoryStore(await makeTempDir());
    const fake = new FakeModelProvider({
      script: [{ text: STRONG_JUDGMENT }],
    });
    const withInventedLink = draftFor(market);
    withInventedLink.links = [
      ...withInventedLink.links,
      { title: "Invented evidence", url: "https://example.invalid/news/invented" },
    ];

    const score = await reviewDraft(
      withInventedLink,
      notesFor(market),
      routedClient(fake),
      store,
    );

    expect(score.passed).toBe(false);
    expect(score.dimensions.sourced.score).toBeLessThan(1);
  });
});
