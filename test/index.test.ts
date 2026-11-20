import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  AGENT_NAME,
  approveDraft,
  createDelphiAdapter,
  createDraftSubmitter,
  draftEvidence,
  FakeModelProvider,
  FakeSearchProvider,
  fixtureMarkets,
  MemoryStore,
  parseSubmissionReceipt,
  pickMarkets,
  recordSettlementReward,
  researchMarket,
  reviewDraft,
  RoutedModelClient,
  runCycle,
  runDraftPipeline,
  STUB_IDENTITY,
  submitDraft,
  syncMarkets,
  TavilySearchProvider,
  validateDraft,
  type DelphiAdapter,
  type EvidenceDraft,
  type ResearchNotes,
} from "../src/index.js";

let tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vgen19-index-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { force: true, recursive: true });
  }
  tempDirs = [];
});

const MARKET = fixtureMarkets[0]!;
const MARKET_ID = MARKET.id;
const ELECTION_URL = "https://example.invalid/news/zanara-election";
const FIXED_NOW = new Date("2026-11-20T10:00:00.000Z");

function routedClient(fake: FakeModelProvider): RoutedModelClient {
  return new RoutedModelClient({
    models: { primary: { fast: "fake-fast", strong: "fake-strong" } },
    primary: fake,
  });
}

function notesWithFindings(): ResearchNotes {
  return {
    compacted: false,
    failedSources: [],
    fetchedAt: "2026-11-20T09:00:00.000Z",
    findings: [
      {
        claim:
          "The Zanara Election Commission announced a general election for 31 December 2026.",
        date: "2025-03-11",
        sourceTitle: "Zanara election announced",
        sourceUrl: ELECTION_URL,
      },
    ],
    marketId: MARKET_ID,
    question:
      "Will the Republic of Zanara hold a general election before 31 December 2026?",
  };
}

function validDraft(overrides: Partial<EvidenceDraft> = {}): EvidenceDraft {
  return {
    createdAt: "2026-11-20T10:00:00.000Z",
    files: [],
    id: "draft-1",
    links: [
      { title: "Zanara election announced", url: ELECTION_URL },
    ],
    marketId: MARKET_ID,
    note: "The Zanara Election Commission announced a general election for 31 December 2026 (2025-03-11).",
    status: "approved",
    ...overrides,
  };
}

const DRAFT_REPLY = JSON.stringify({
  links: [{ title: "Zanara election announced", url: ELECTION_URL }],
  note: "The Zanara Election Commission announced a general election for 31 December 2026 (2025-03-11).",
});

const STRONG_JUDGMENT = JSON.stringify({
  noInventedFacts: {
    rationale: "Judge: every claim is supported by the findings.",
    score: 1,
  },
  novel: { rationale: "Judge: the facts are new.", score: 1 },
  relevant: { rationale: "Judge: the note answers the question.", score: 1 },
  sourced: { rationale: "Judge: the claims cite their links.", score: 1 },
});

describe("public API", () => {
  it("exposes the agent name", () => {
    expect(AGENT_NAME).toBe("Vgen19");
  });

  it("builds a working adapter from the factory", async () => {
    const adapter = createDelphiAdapter();

    expect(adapter.identity.agentName).toBe("Vgen19");
    expect((await adapter.listMarkets()).length).toBeGreaterThan(0);
    expect((await adapter.health()).status).toBe("ok");
    const markets = await adapter.listMarkets({ limit: 1 });
    const single = await adapter.getMarket({ id: markets[0]!.id });
    expect(single.id).toBe(markets[0]!.id);
  });

  it("stores and loads markets through the memory store", async () => {
    const store = new MemoryStore(await makeTempDir());

    await store.saveMarkets([MARKET]);
    const stored = await store.loadMarkets();

    expect(stored).toEqual([MARKET]);
  });

  it("syncs markets from the adapter into the store", async () => {
    const store = new MemoryStore(await makeTempDir());
    const adapter = createDelphiAdapter();

    const result = await syncMarkets(adapter, store);

    expect(result.added).toBe(fixtureMarkets.length);
    expect(await store.loadMarkets()).toEqual(fixtureMarkets);
  });

  it("picks the open fixture markets and skips the non-open one", () => {
    const open = fixtureMarkets.filter((market) => market.status === "open");

    const result = pickMarkets(fixtureMarkets, {
      now: FIXED_NOW,
      previouslyStoredIds: new Set(),
      submissionsByMarket: {},
    });

    expect(result.picked.map((market) => market.id)).toEqual(
      open.map((market) => market.id),
    );
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.reason).toBe("not-open");
  });

  it("researches a market with the fake search and model", async () => {
    const store = new MemoryStore(await makeTempDir());
    await store.saveMarkets([MARKET]);
    const search = new FakeSearchProvider({
      results: [
        {
          snippet: "The Zanara Election Commission announced an election.",
          title: "Zanara election announced",
          url: ELECTION_URL,
        },
      ],
    });
    const fake = new FakeModelProvider({
      script: [
        {
          text: JSON.stringify({
            findings: [
              {
                claim:
                  "The Zanara Election Commission announced an election.",
                date: "2025-03-11",
              },
            ],
          }),
        },
      ],
    });

    const notes = await researchMarket(MARKET, {
      model: routedClient(fake),
      now: () => FIXED_NOW,
      readPage: async (url: string) => ({
        text: "The Zanara Election Commission announced an election.",
        url,
      }),
      search,
      store,
    });

    expect(notes.findings).toHaveLength(1);
    expect(notes.findings[0]!.sourceUrl).toBe(ELECTION_URL);
  });

  it("searches Tavily through a stubbed fetch", async () => {
    const provider = new TavilySearchProvider({
      apiKey: "test-key",
      fetchFn: async () =>
        ({
          json: () =>
            Promise.resolve({
              results: [
                {
                  content: "The Zanara Election Commission announced an election.",
                  title: "Zanara election announced",
                  url: ELECTION_URL,
                },
              ],
            }),
          ok: true,
          status: 200,
        }) as never,
    });

    const response = await provider.search("Zanara election");

    expect(response.results).toHaveLength(1);
    expect(response.results[0]!.url).toBe(ELECTION_URL);
  });

  it("drafts evidence from research notes with the fake model", async () => {
    const fake = new FakeModelProvider({ script: [{ text: DRAFT_REPLY }] });

    const draft = await draftEvidence(
      notesWithFindings(),
      routedClient(fake),
      { createId: () => "draft-1", now: () => FIXED_NOW },
    );

    expect(draft).toBeDefined();
    expect(draft!.marketId).toBe(MARKET_ID);
    expect(draft!.links).toHaveLength(1);
    expect(() => validateDraft(draft!)).not.toThrow();
  });

  it("reviews a grounded draft as passing with the fake model", async () => {
    const store = new MemoryStore(await makeTempDir());
    const fake = new FakeModelProvider({
      script: [{ text: STRONG_JUDGMENT }],
    });

    const score = await reviewDraft(
      validDraft(),
      notesWithFindings(),
      routedClient(fake),
      store,
      { now: () => FIXED_NOW },
    );

    expect(score.passed).toBe(true);
    expect(score.overall).toBe(1);
  });

  it("runs the draft pipeline end to end on stored notes", async () => {
    const store = new MemoryStore(await makeTempDir());
    const fake = new FakeModelProvider({
      script: [{ text: DRAFT_REPLY }, { text: STRONG_JUDGMENT }],
    });

    const result = await runDraftPipeline({
      createId: () => "draft-1",
      market: MARKET,
      model: routedClient(fake),
      notes: notesWithFindings(),
      now: () => FIXED_NOW,
      store,
    });

    expect(result.outcome).toBe("drafted");
    if (result.outcome === "drafted") {
      expect(result.draft.status).toBe("approved");
      expect(result.submitted).toBe(false);
    }
  });

  it("submits an approved draft through the stub adapter", async () => {
    const store = new MemoryStore(await makeTempDir());
    const draft = validDraft();
    await store.saveDraft(draft);
    await approveDraft(store, draft.id, undefined, { now: () => FIXED_NOW });
    const adapter = createDelphiAdapter();

    const { receipt, submission } = await submitDraft(draft, {
      adapter,
      cycleId: "cycle-1",
      model: "fake-strong",
      now: () => FIXED_NOW,
      store,
    });

    expect(receipt.verdict).toBe("accepted");
    expect(submission.draftId).toBe("draft-1");
    expect((await store.loadDraft("draft-1"))!.status).toBe("submitted");
  });

  it("binds the pipeline submitter seam and parses receipts strictly", async () => {
    const store = new MemoryStore(await makeTempDir());
    const draft = validDraft();
    await store.saveDraft(draft);
    await approveDraft(store, draft.id);
    const submit = createDraftSubmitter({
      adapter: createDelphiAdapter(),
      cycleId: "cycle-1",
      model: "fake-strong",
      store,
    });

    await expect(submit(draft)).resolves.toBeUndefined();

    const receipt = parseSubmissionReceipt({
      draftId: "draft-1",
      marketId: MARKET_ID,
      submissionId: "sub-1",
      submittedAt: "2026-11-20T10:00:00.000Z",
      verdict: "accepted",
    });
    expect(receipt.verdict).toBe("accepted");
  });

  it("records a settlement reward against a submission", async () => {
    const store = new MemoryStore(await makeTempDir());
    const draft = validDraft();
    await store.saveDraft(draft);
    await approveDraft(store, draft.id);
    const { submission } = await submitDraft(draft, {
      adapter: createDelphiAdapter(),
      cycleId: "cycle-1",
      model: "fake-strong",
      store,
    });

    const reward = await recordSettlementReward(store, submission.id, 1.5, {
      now: () => FIXED_NOW,
    });

    expect(reward.settlement).toBe(1.5);
    expect(reward.draftId).toBe("draft-1");
  });

  it("runs a cycle with no markets and completes with nothing picked", async () => {
    const dataDir = await makeTempDir();
    const store = new MemoryStore(dataDir);
    const emptyAdapter: DelphiAdapter = {
      identity: STUB_IDENTITY,
      async getMarket() {
        throw new Error("no markets");
      },
      async health() {
        return { status: "ok" };
      },
      async listMarkets() {
        return [];
      },
      async submitEvidence() {
        throw new Error("no submissions");
      },
    };

    const summary = await runCycle({
      adapter: emptyAdapter,
      approvalGate: false,
      cycleId: "cycle-1",
      dataDir,
      model: routedClient(new FakeModelProvider()),
      now: () => FIXED_NOW,
      readPage: async (url: string) => ({ text: "", url }),
      search: new FakeSearchProvider(),
      store,
      warn: () => {},
    });

    expect(summary.status).toBe("completed");
    expect(summary.marketsPicked).toEqual([]);
    expect(summary.drafts).toEqual([]);
    expect(summary.submissions).toEqual([]);
  });
});
