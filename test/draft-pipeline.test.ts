import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { fixtureMarkets } from "../src/delphi/fixtures.js";
import type { Market } from "../src/delphi/types.js";
import type { EvidenceDraft } from "../src/draft/index.js";
import { runDraftPipeline } from "../src/draft/index.js";
import { FakeModelProvider } from "../src/llm/fake.js";
import { RoutedModelClient } from "../src/llm/client.js";
import { MemoryStore } from "../src/memory/store.js";
import type { ResearchNotes } from "../src/research/index.js";
import { FakeSearchProvider } from "../src/search/index.js";

let tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vgen19-draft-pipeline-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { force: true, recursive: true });
  }
  tempDirs = [];
});

const MARKET: Market = fixtureMarkets[0]!;
const ELECTION_URL = "https://example.invalid/news/zanara-election";
const FIXED_NOW = new Date("2026-11-20T10:00:00.000Z");
const CLAIM =
  "The Zanara Election Commission announced a general election for 31 December 2026.";

function extractionReply(): string {
  return JSON.stringify({
    findings: [{ claim: CLAIM, date: "2025-03-11" }],
  });
}

function draftReply(): string {
  return JSON.stringify({
    links: [{ title: "Zanara election announced", url: ELECTION_URL }],
    note: "The Zanara Election Commission announced a general election for 31 December 2026 (2025-03-11).",
  });
}

function judgeReply(score: number): string {
  return JSON.stringify({
    noInventedFacts: { rationale: "Judge: supported.", score },
    novel: { rationale: "Judge: new.", score },
    relevant: { rationale: "Judge: relevant.", score },
    sourced: { rationale: "Judge: cited.", score },
  });
}

/** A recording fake submitter: counts every call and keeps the drafts. */
function recordingSubmitter(): {
  calls: EvidenceDraft[];
  submit: (draft: EvidenceDraft) => Promise<void>;
} {
  const calls: EvidenceDraft[] = [];
  return {
    calls,
    submit: async (draft: EvidenceDraft) => {
      calls.push(draft);
    },
  };
}

interface Harness {
  fakeModel: FakeModelProvider;
  fakeSearch: FakeSearchProvider;
  store: MemoryStore;
  model: RoutedModelClient;
}

async function makeHarness(options: {
  judgeScore?: number;
  modelScript?: string[];
}): Promise<Harness> {
  const dataDir = await makeTempDir();
  const store = new MemoryStore(dataDir);
  await store.saveMarkets([MARKET]);
  const fakeModel = new FakeModelProvider({
    script: (options.modelScript ?? [
      extractionReply(),
      draftReply(),
      judgeReply(options.judgeScore ?? 1),
    ]).map((text) => ({ text })),
  });
  const fakeSearch = new FakeSearchProvider({
    results: [
      {
        publishedDate: "Tue, 11 Mar 2025 17:00:00 GMT",
        snippet: "The Zanara Election Commission announced an election.",
        title: "Zanara election announced",
        url: ELECTION_URL,
      },
    ],
  });
  return {
    fakeModel,
    fakeSearch,
    model: new RoutedModelClient({
      models: { primary: { fast: "fake-fast", strong: "fake-strong" } },
      primary: fakeModel,
    }),
    store,
  };
}

function notesWithFindings(): ResearchNotes {
  return {
    compacted: false,
    failedSources: [],
    fetchedAt: "2026-11-20T09:00:00.000Z",
    findings: [
      {
        claim: CLAIM,
        date: "2025-03-11",
        sourceTitle: "Zanara election announced",
        sourceUrl: ELECTION_URL,
      },
    ],
    marketId: MARKET.id,
    question:
      "Will the Republic of Zanara hold a general election before 31 December 2026?",
  };
}

describe("runDraftPipeline", () => {
  it("in dry-run mode drafts and saves evidence but never calls submit", async () => {
    const { fakeSearch, model, store } = await makeHarness({});
    const { calls, submit } = recordingSubmitter();

    const result = await runDraftPipeline({
      createId: () => "draft-1",
      dryRun: true,
      market: MARKET,
      model,
      now: () => FIXED_NOW,
      readPage: async (url: string) => ({
        text: "The Zanara Election Commission announced a general election for 31 December 2026.",
        url,
      }),
      search: fakeSearch,
      store,
      submit,
    });

    expect(calls).toHaveLength(0);
    expect(result.outcome).toBe("drafted");
    if (result.outcome !== "drafted") {
      throw new Error("expected a drafted outcome");
    }
    expect(result.submitted).toBe(false);
    expect(result.draft.status).toBe("approved");
    expect(result.draft.score?.passed).toBe(true);
    expect(result.notes.findings).toHaveLength(1);

    const saved = await store.loadDraft("draft-1");
    expect(saved?.status).toBe("approved");
    expect(saved?.score?.overall).toBeCloseTo(1);
    const savedNotes = await store.loadResearchNotes(MARKET.id);
    expect(savedNotes?.findings).toHaveLength(1);
  });

  it("outside dry-run mode submits an approved draft exactly once", async () => {
    const { fakeSearch, model, store } = await makeHarness({});
    const { calls, submit } = recordingSubmitter();

    const result = await runDraftPipeline({
      createId: () => "draft-1",
      market: MARKET,
      model,
      now: () => FIXED_NOW,
      readPage: async (url: string) => ({
        text: "The Zanara Election Commission announced a general election for 31 December 2026.",
        url,
      }),
      search: fakeSearch,
      store,
      submit,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.id).toBe("draft-1");
    expect(result.outcome).toBe("drafted");
    if (result.outcome !== "drafted") {
      throw new Error("expected a drafted outcome");
    }
    expect(result.submitted).toBe(true);
    expect(result.draft.status).toBe("submitted");

    const saved = await store.loadDraft("draft-1");
    expect(saved?.status).toBe("submitted");
  });

  it("never submits a rejected draft, even outside dry-run mode", async () => {
    const { fakeSearch, model, store } = await makeHarness({
      judgeScore: 0.2,
    });
    const { calls, submit } = recordingSubmitter();

    const result = await runDraftPipeline({
      createId: () => "draft-1",
      market: MARKET,
      model,
      now: () => FIXED_NOW,
      readPage: async (url: string) => ({
        text: "The Zanara Election Commission announced a general election for 31 December 2026.",
        url,
      }),
      search: fakeSearch,
      store,
      submit,
    });

    expect(calls).toHaveLength(0);
    expect(result.outcome).toBe("drafted");
    if (result.outcome !== "drafted") {
      throw new Error("expected a drafted outcome");
    }
    expect(result.submitted).toBe(false);
    expect(result.draft.status).toBe("rejected");
    expect(result.draft.score?.passed).toBe(false);

    const saved = await store.loadDraft("draft-1");
    expect(saved?.status).toBe("rejected");
    expect(saved?.score?.passed).toBe(false);
  });

  it("records no draft when the research finds nothing, and submits nothing", async () => {
    const dataDir = await makeTempDir();
    const store = new MemoryStore(dataDir);
    await store.saveMarkets([MARKET]);
    const fakeModel = new FakeModelProvider();
    const { calls, submit } = recordingSubmitter();

    const result = await runDraftPipeline({
      market: MARKET,
      model: new RoutedModelClient({
        models: { primary: { fast: "fake-fast", strong: "fake-strong" } },
        primary: fakeModel,
      }),
      now: () => FIXED_NOW,
      readPage: async (url: string) => ({ text: "", url }),
      search: new FakeSearchProvider({ results: [] }),
      store,
      submit,
    });

    expect(calls).toHaveLength(0);
    expect(result.outcome).toBe("no-draft");
    if (result.outcome !== "no-draft") {
      throw new Error("expected a no-draft outcome");
    }
    expect(result.reason).toBe("no draft: no findings");
    expect(result.notes.findings).toHaveLength(0);
    expect(fakeModel.calls).toHaveLength(0);
    expect(await store.loadDrafts(MARKET.id)).toHaveLength(0);
  });

  it("skips research when notes are already provided", async () => {
    const { fakeSearch, model, store } = await makeHarness({
      modelScript: [draftReply(), judgeReply(1)],
    });
    const { calls, submit } = recordingSubmitter();

    const result = await runDraftPipeline({
      createId: () => "draft-1",
      dryRun: true,
      market: MARKET,
      model,
      notes: notesWithFindings(),
      now: () => FIXED_NOW,
      search: fakeSearch,
      store,
      submit,
    });

    expect(fakeSearch.queries).toHaveLength(0);
    expect(calls).toHaveLength(0);
    expect(result.outcome).toBe("drafted");
    if (result.outcome !== "drafted") {
      throw new Error("expected a drafted outcome");
    }
    expect(result.draft.status).toBe("approved");
    expect(result.notes.findings).toHaveLength(1);
  });

  it("fails clearly when research is needed but no search provider is given", async () => {
    const { model, store } = await makeHarness({});

    await expect(
      runDraftPipeline({
        market: MARKET,
        model,
        store,
      }),
    ).rejects.toThrow(/search/);
  });
});
