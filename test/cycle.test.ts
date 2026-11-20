import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { AgentIdentity } from "../src/delphi/types.js";
import { StubDelphiAdapter } from "../src/delphi/stub.js";
import type { EvidenceDraft } from "../src/draft/types.js";
import { FakeModelProvider } from "../src/llm/fake.js";
import { RoutedModelClient } from "../src/llm/client.js";
import { MemoryStore } from "../src/memory/store.js";
import { FakeSearchProvider } from "../src/search/fake.js";
import { runCycle, type CycleDeps } from "../src/cycle/runner.js";
import type { TraceEntry } from "../src/cycle/trace.js";

let tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vgen19-cycle-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { force: true, recursive: true });
  }
  tempDirs = [];
});

const FIXED_NOW = new Date("2026-11-20T10:00:00.000Z");
const ELECTION_URL = "https://example.invalid/news/zanara-election";
const CLAIM =
  "The Zanara Election Commission announced a general election for 31 December 2026.";
const PAGE_TEXT =
  "The Zanara Election Commission announced a general election for 31 December 2026.";

/**
 * One reply per call kind the cycle makes, keyed on the system
 * prompt: extraction reads `findings`, drafting reads `note` and
 * `links`, judging reads the four dimensions. Strict validation
 * rejects unknown fields, so a single canned reply can no longer
 * answer every call kind.
 */
function replyForCallKind(messages: Array<{ content: string; role: string }>): string {
  const system =
    messages.find((message) => message.role === "system")?.content ?? "";
  if (system.includes("You extract dated factual claims")) {
    return JSON.stringify({
      findings: [{ claim: CLAIM, date: "2025-03-11" }],
    });
  }
  if (system.includes("You draft short evidence notes")) {
    return JSON.stringify({
      links: [{ title: "Zanara election announced", url: ELECTION_URL }],
      note: "The Zanara Election Commission announced a general election for 31 December 2026 (2025-03-11).",
    });
  }
  if (system.includes("You judge evidence drafts")) {
    return JSON.stringify({
      noInventedFacts: { rationale: "Judge: supported.", score: 1 },
      novel: { rationale: "Judge: new.", score: 1 },
      relevant: { rationale: "Judge: relevant.", score: 1 },
      sourced: { rationale: "Judge: cited.", score: 1 },
    });
  }
  throw new Error(`Unexpected model call in cycle test: ${system.slice(0, 80)}`);
}

/** A stub adapter that dies after a number of submissions (resume test). */
class FlakyAdapter extends StubDelphiAdapter {
  crashAfter = Number.POSITIVE_INFINITY;

  override async submitEvidence(
    draft: EvidenceDraft,
    meta: AgentIdentity,
  ): Promise<unknown> {
    if (this.recordedSubmissions.length >= this.crashAfter) {
      throw new Error("simulated crash: adapter died mid-cycle");
    }
    return super.submitEvidence(draft, meta);
  }
}

interface CycleHarness {
  adapter: StubDelphiAdapter;
  createId: () => string;
  dataDir: string;
  fakeModel: FakeModelProvider;
  fakeSearch: FakeSearchProvider;
  model: RoutedModelClient;
  store: MemoryStore;
}

async function makeHarness(options: {
  adapter?: StubDelphiAdapter;
  budget?: number;
} = {}): Promise<CycleHarness> {
  const dataDir = await makeTempDir();
  const store = new MemoryStore(dataDir);
  const fakeModel = new FakeModelProvider({ replyFor: replyForCallKind });
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
  const adapter = options.adapter ?? new StubDelphiAdapter();
  const model = new RoutedModelClient({
    budget: options.budget,
    models: { primary: { fast: "fake-fast", strong: "fake-strong" } },
    primary: fakeModel,
  });
  let counter = 0;
  return {
    adapter,
    createId: () => {
      counter += 1;
      return `draft-${counter}`;
    },
    dataDir,
    fakeModel,
    fakeSearch,
    model,
    store,
  };
}

function cycleDeps(
  harness: CycleHarness,
  overrides: Partial<CycleDeps> = {},
): CycleDeps {
  return {
    adapter: harness.adapter,
    approvalGate: false,
    createId: harness.createId,
    cycleId: "cycle-1",
    dataDir: harness.dataDir,
    model: harness.model,
    now: () => FIXED_NOW,
    readPage: async (url: string) => ({ text: PAGE_TEXT, url }),
    search: harness.fakeSearch,
    store: harness.store,
    // The gate-off warning belongs to the submitter (tested there);
    // keep it out of the cycle test output.
    warn: () => {},
    ...overrides,
  };
}

async function readTrace(dataDir: string, cycleId: string): Promise<TraceEntry[]> {
  const raw = await readFile(
    join(dataDir, "traces", `${cycleId}.jsonl`),
    "utf-8",
  );
  return raw
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as TraceEntry);
}

const OPEN_MARKET_IDS = [
  "0x0000000000000000000000000000000000000001",
  "0x0000000000000000000000000000000000000002",
  "0x0000000000000000000000000000000000000004",
  "0x0000000000000000000000000000000000000005",
];
const SETTLED_MARKET_ID =
  "0x0000000000000000000000000000000000000003";

describe("runCycle", () => {
  it("runs a full cycle end to end and writes a report, trace, and cost record", async () => {
    const harness = await makeHarness({});

    const summary = await runCycle(cycleDeps(harness));

    expect(summary.cycleId).toBe("cycle-1");
    expect(summary.status).toBe("completed");
    expect(summary.marketsChecked).toHaveLength(5);
    expect(summary.marketsPicked).toEqual(OPEN_MARKET_IDS);
    expect(summary.marketsSkipped).toEqual([
      { marketId: SETTLED_MARKET_ID, reason: "not-open" },
    ]);
    expect(summary.drafts).toHaveLength(4);
    expect(summary.drafts.every((draft) => draft.reviewPassed)).toBe(true);
    expect(summary.submissions).toHaveLength(4);
    expect(
      summary.submissions.every(
        (submission) => submission.verdict === "accepted",
      ),
    ).toBe(true);
    expect(summary.refusals).toHaveLength(0);
    expect(summary.rewardsSoFar).toEqual({
      judgment: 0,
      settlement: 0,
      total: 0,
    });
    expect(summary.errors).toHaveLength(0);
    expect(summary.budgetExhausted).toBe(false);

    // Cost tracking matches the fakes' recorded calls: 3 model calls
    // (extract, draft, judge) and 3 searches per market, 4 markets.
    // The fake search reports 1 credit per search, so the cycle's
    // cost record reports 12 credits, not 0.
    expect(summary.cost.modelCalls).toBe(12);
    expect(summary.cost.modelCalls).toBe(harness.fakeModel.calls.length);
    expect(summary.cost.searchCalls).toBe(12);
    expect(summary.cost.searchCalls).toBe(harness.fakeSearch.queries.length);
    expect(summary.cost.searchCreditsUsed).toBe(12);

    // Memory is the source of truth: 4 submissions, 4 submitted drafts.
    const submissions = await harness.store.loadSubmissions();
    expect(submissions).toHaveLength(4);
    const drafts = await harness.store.loadDrafts();
    expect(drafts).toHaveLength(4);
    expect(drafts.every((draft) => draft.status === "submitted")).toBe(true);

    // The report, trace, and cost record exist and agree with the summary.
    const report = await readFile(summary.reportPath, "utf-8");
    expect(report).toContain("cycle-1");
    expect(report).toContain("draft-1");
    expect(report).toContain("accepted");
    const costRecord = JSON.parse(
      await readFile(summary.costPath, "utf-8"),
    ) as { modelCalls: number; searchCalls: number };
    expect(costRecord.modelCalls).toBe(12);
    expect(costRecord.searchCalls).toBe(12);

    const trace = await readTrace(harness.dataDir, "cycle-1");
    const steps = trace.map((entry) => entry.step);
    for (const step of [
      "cycle-start",
      "market-sync",
      "market-pick",
      "market-start",
      "research-start",
      "research-end",
      "draft-created",
      "approval-decision",
      "submission-attempt",
      "receipt",
      "market-end",
      "cycle-end",
    ] as const) {
      expect(steps).toContain(step);
    }
    expect(steps.filter((step) => step === "receipt")).toHaveLength(4);
    expect(steps).not.toContain("refusal");
    expect(steps).not.toContain("error");
    expect(trace.every((entry) => entry.cycleId === "cycle-1")).toBe(true);
  });

  it("caps the markets worked per cycle", async () => {
    const harness = await makeHarness({});

    const summary = await runCycle(
      cycleDeps(harness, { maxMarketsPerCycle: 2 }),
    );

    expect(summary.marketsPicked).toHaveLength(2);
    expect(summary.drafts).toHaveLength(2);
    expect(summary.submissions).toHaveLength(2);
    expect(
      summary.marketsSkipped.filter(
        (skipped) => skipped.reason === "over-cap",
      ),
    ).toHaveLength(2);
  });

  it("enforces the per-cycle submission cap through the submitter", async () => {
    const harness = await makeHarness({});

    const summary = await runCycle(
      cycleDeps(harness, { maxSubmissionsPerCycle: 2 }),
    );

    expect(summary.submissions).toHaveLength(2);
    expect(summary.refusals).toHaveLength(2);
    expect(
      summary.refusals.every((refusal) => refusal.reason === "cap-cycle"),
    ).toBe(true);
    // The refused drafts stay approved for a later cycle.
    const drafts = await harness.store.loadDrafts();
    expect(
      drafts.filter((draft) => draft.status === "approved"),
    ).toHaveLength(2);
  });

  it("records gate refusals when the approval gate is on and no approval exists", async () => {
    const harness = await makeHarness({});

    const summary = await runCycle(
      cycleDeps(harness, { approvalGate: true }),
    );

    expect(summary.submissions).toHaveLength(0);
    expect(summary.refusals).toHaveLength(4);
    expect(
      summary.refusals.every((refusal) => refusal.reason === "gate"),
    ).toBe(true);
    expect(summary.drafts).toHaveLength(4);
    const drafts = await harness.store.loadDrafts();
    expect(drafts.every((draft) => draft.status === "approved")).toBe(true);

    const trace = await readTrace(harness.dataDir, "cycle-1");
    const steps = trace.map((entry) => entry.step);
    expect(steps.filter((step) => step === "refusal")).toHaveLength(4);
    expect(steps).not.toContain("receipt");
  });

  it("submits an approved draft from a previous cycle once the gate allows it", async () => {
    const harness = await makeHarness({});
    const marketId = OPEN_MARKET_IDS[0]!;
    await harness.store.addKnownFacts(marketId, [
      {
        claim: CLAIM,
        date: "2025-03-11",
        normalizedClaim: CLAIM.toLowerCase(),
        recordedAt: "2026-11-20T09:00:00.000Z",
        sourceUrl: ELECTION_URL,
      },
    ]);
    await harness.store.saveDraft({
      createdAt: "2026-11-20T09:00:00.000Z",
      files: [],
      id: "draft-old",
      links: [{ title: "Zanara election announced", url: ELECTION_URL }],
      marketId,
      note: "The Zanara Election Commission announced a general election for 31 December 2026 (2025-03-11).",
      status: "approved",
    });
    await harness.store.saveApproval({
      approvedAt: "2026-11-20T09:30:00.000Z",
      approvedBy: "human",
      draftId: "draft-old",
    });

    const summary = await runCycle(
      cycleDeps(harness, {
        approvalGate: true,
        maxMarketsPerCycle: 1,
      }),
    );

    // The old approved draft went out; no new draft was made, because
    // the research found no findings beyond the known facts.
    expect(summary.submissions).toHaveLength(1);
    expect(summary.submissions[0]!.draftId).toBe("draft-old");
    expect(summary.drafts).toHaveLength(0);
    const saved = await harness.store.loadDraft("draft-old");
    expect(saved?.status).toBe("submitted");
  });

  it("re-running a cycle never resubmits evidence", async () => {
    const harness = await makeHarness({});

    const first = await runCycle(cycleDeps(harness, { cycleId: "cycle-1" }));
    expect(first.submissions).toHaveLength(4);
    const submissionsAfterFirst = await harness.store.loadSubmissions();
    const idsAfterFirst = submissionsAfterFirst.map(
      (submission) => submission.id,
    );

    const secondAdapter = new StubDelphiAdapter();
    const second = await runCycle(
      cycleDeps(harness, {
        adapter: secondAdapter,
        cycleId: "cycle-2",
      }),
    );

    expect(second.submissions).toHaveLength(0);
    expect(second.drafts).toHaveLength(0);
    expect(secondAdapter.recordedSubmissions).toHaveLength(0);
    const submissionsAfterSecond = await harness.store.loadSubmissions();
    expect(submissionsAfterSecond.map((s) => s.id)).toEqual(idsAfterFirst);
  });

  it("resumes after an interruption: no records lost, nothing resubmitted", async () => {
    const adapter = new FlakyAdapter();
    adapter.crashAfter = 2;
    const harness = await makeHarness({ adapter });

    await expect(
      runCycle(cycleDeps(harness, { cycleId: "cycle-1" })),
    ).rejects.toThrow("simulated crash");

    // The two submissions before the crash are intact in memory.
    const submissionsAfterCrash = await harness.store.loadSubmissions();
    expect(submissionsAfterCrash).toHaveLength(2);
    expect(
      submissionsAfterCrash.map((submission) => submission.marketId),
    ).toEqual([OPEN_MARKET_IDS[0], OPEN_MARKET_IDS[1]]);
    const draftsAfterCrash = await harness.store.loadDrafts();
    expect(
      draftsAfterCrash.filter((draft) => draft.status === "submitted"),
    ).toHaveLength(2);
    expect(
      draftsAfterCrash.filter((draft) => draft.status === "approved"),
    ).toHaveLength(1);

    // The interrupted cycle kept its trace up to the crash.
    const trace = await readTrace(harness.dataDir, "cycle-1");
    expect(trace.map((entry) => entry.step)).toContain("cycle-start");
    expect(trace.map((entry) => entry.step)).toContain("error");
    expect(trace.map((entry) => entry.step)).toContain("cycle-end");

    // Re-run with the adapter healthy: the remaining markets complete,
    // the crashed market's approved draft goes out, and nothing from
    // the first run is submitted twice.
    adapter.crashAfter = Number.POSITIVE_INFINITY;
    const resumed = await runCycle(
      cycleDeps(harness, { cycleId: "cycle-2" }),
    );

    expect(resumed.status).toBe("completed");
    expect(resumed.submissions).toHaveLength(2);
    const submissionsAfterResume = await harness.store.loadSubmissions();
    expect(submissionsAfterResume).toHaveLength(4);
    expect(
      submissionsAfterResume.map((submission) => submission.marketId).sort(),
    ).toEqual([...OPEN_MARKET_IDS].sort());
    const submittedDraftIds = adapter.recordedSubmissions.map(
      (record) => record.draft.id,
    );
    expect(new Set(submittedDraftIds).size).toBe(submittedDraftIds.length);
    expect(
      adapter.recordedSubmissions.filter(
        (record) => record.draft.marketId === OPEN_MARKET_IDS[0],
      ),
    ).toHaveLength(1);
  });

  it("in dry-run mode drafts but never submits", async () => {
    const harness = await makeHarness({});

    const summary = await runCycle(cycleDeps(harness, { dryRun: true }));

    expect(summary.dryRun).toBe(true);
    expect(summary.drafts).toHaveLength(4);
    expect(summary.submissions).toHaveLength(0);
    expect(harness.adapter.recordedSubmissions).toHaveLength(0);
    const drafts = await harness.store.loadDrafts();
    expect(drafts.every((draft) => draft.status === "approved")).toBe(true);
    const report = await readFile(summary.reportPath, "utf-8");
    expect(report).toMatch(/dry-run/i);
  });

  it("stops drafting when the model-call budget is exhausted and does not throw", async () => {
    // Budget 3: exactly one market (extract, draft, judge), then the
    // proactive check stops the cycle before the next market.
    const harness = await makeHarness({ budget: 3 });

    const summary = await runCycle(cycleDeps(harness));

    expect(summary.status).toBe("completed");
    expect(summary.budgetExhausted).toBe(true);
    expect(summary.drafts).toHaveLength(1);
    expect(summary.submissions).toHaveLength(1);
    const report = await readFile(summary.reportPath, "utf-8");
    expect(report).toMatch(/anggaran/i);
  });

  it("stops picking new markets once the time budget passes, and finishes normally", async () => {
    const harness = await makeHarness({});
    // A mutable clock: the first market's page read takes us past
    // the 1-minute budget, so the second market is never started.
    let currentTime = FIXED_NOW;
    const summary = await runCycle(
      cycleDeps(harness, {
        cycleTimeBudgetMinutes: 1,
        now: () => currentTime,
        readPage: async (url: string) => {
          currentTime = new Date(FIXED_NOW.getTime() + 2 * 60_000);
          return { text: PAGE_TEXT, url };
        },
      }),
    );

    expect(summary.status).toBe("completed");
    expect(summary.timeBudgetExhausted).toBe(true);
    expect(summary.marketsPicked).toHaveLength(4);
    expect(summary.drafts).toHaveLength(1);
    expect(summary.submissions).toHaveLength(1);
    const report = await readFile(summary.reportPath, "utf-8");
    expect(report).toMatch(/batas waktu siklus habis/i);
  });

  it("fails the cycle when the market sync fails", async () => {
    const harness = await makeHarness({});
    const failingAdapter = new StubDelphiAdapter();
    failingAdapter.listMarkets = async () => {
      throw new Error("Delphi unreachable");
    };

    await expect(
      runCycle(cycleDeps(harness, { adapter: failingAdapter })),
    ).rejects.toThrow("Delphi unreachable");

    const trace = await readTrace(harness.dataDir, "cycle-1");
    const steps = trace.map((entry) => entry.step);
    expect(steps).toContain("cycle-start");
    expect(steps).toContain("error");
    expect(steps).toContain("cycle-end");
    expect(await harness.store.loadSubmissions()).toHaveLength(0);
  });

  it("generates a cycle id from the clock when none is given", async () => {
    const harness = await makeHarness({});
    const deps = cycleDeps(harness);
    delete deps.cycleId;

    const summary = await runCycle(deps);

    expect(summary.cycleId).toBe("cycle-2026-11-20T10:00:00.000Z");
  });
});
