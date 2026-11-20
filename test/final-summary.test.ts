import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { fixtureMarkets } from "../src/delphi/fixtures.js";
import type { EvidenceDraft } from "../src/draft/types.js";
import { MemoryStore } from "../src/memory/store.js";
import type {
  RewardRecord,
  SubmissionRecord,
} from "../src/submit/types.js";
import { aggregateFinalSummary } from "../src/summary/aggregate.js";

let tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vgen19-final-summary-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { force: true, recursive: true });
  }
  tempDirs = [];
});

const MARKET_A = fixtureMarkets[0]!;
const MARKET_B = fixtureMarkets[1]!;
const QUESTION_A = MARKET_A.metadata?.question ?? MARKET_A.id;
const QUESTION_B = MARKET_B.metadata?.question ?? MARKET_B.id;

function makeSubmission(
  overrides: Partial<SubmissionRecord> & { id: string },
): SubmissionRecord {
  return {
    cycleId: "cycle-1",
    draftId: `draft-${overrides.id}`,
    marketId: MARKET_A.id,
    receipt: {
      draftId: `draft-${overrides.id}`,
      marketId: MARKET_A.id,
      submissionId: overrides.id,
      submittedAt: "2026-11-24T02:30:00.000Z",
      verdict: "accepted",
    },
    recordedAt: "2026-11-24T02:30:00.000Z",
    status: "accepted",
    ...overrides,
  };
}

function makeDraft(
  id: string,
  marketId: string,
  note: string,
): EvidenceDraft {
  return {
    createdAt: "2026-11-24T02:00:00.000Z",
    files: [],
    id,
    links: [
      {
        title: "Source for the evidence",
        url: `https://example.invalid/sources/${id}`,
      },
    ],
    marketId,
    note,
    status: "submitted",
  };
}

function makeReward(
  submissionId: string,
  draftId: string,
  marketId: string,
  judgment?: number,
  settlement?: number,
): RewardRecord {
  return {
    currency: "USDC",
    draftId,
    marketId,
    recordedAt: "2026-11-24T03:00:00.000Z",
    submissionId,
    ...(judgment !== undefined ? { judgment } : {}),
    ...(settlement !== undefined ? { settlement } : {}),
  };
}

/**
 * Seed a data dir with two completed cycles, one failed cycle, and
 * one orphan trace, plus a malformed line in each file-based source.
 */
async function seedDataDir(): Promise<string> {
  const dataDir = await makeTempDir();
  const store = new MemoryStore(dataDir);
  await store.saveMarkets([MARKET_A, MARKET_B]);

  const submissions = [
    makeSubmission({
      cycleId: "cycle-1",
      draftId: "draft-sub-1",
      id: "sub-1",
      marketId: MARKET_A.id,
      status: "accepted",
    }),
    makeSubmission({
      cycleId: "cycle-1",
      draftId: "draft-sub-2",
      id: "sub-2",
      marketId: MARKET_A.id,
      receipt: {
        draftId: "draft-sub-2",
        marketId: MARKET_A.id,
        submissionId: "sub-2",
        submittedAt: "2026-11-24T02:35:00.000Z",
        verdict: "judged",
      },
      status: "judged",
    }),
    makeSubmission({
      cycleId: "cycle-1",
      draftId: "draft-sub-3",
      id: "sub-3",
      marketId: MARKET_B.id,
      receipt: {
        draftId: "draft-sub-3",
        marketId: MARKET_B.id,
        rationale: "Not sourced.",
        submissionId: "sub-3",
        submittedAt: "2026-11-24T02:40:00.000Z",
        verdict: "rejected",
      },
      status: "rejected",
    }),
    makeSubmission({
      cycleId: "cycle-2",
      draftId: "draft-sub-4",
      id: "sub-4",
      marketId: MARKET_B.id,
      status: "accepted",
    }),
    makeSubmission({
      cycleId: "cycle-2",
      draftId: "draft-sub-5",
      id: "sub-5",
      marketId: MARKET_B.id,
      receipt: {
        draftId: "draft-sub-5",
        marketId: MARKET_B.id,
        submissionId: "sub-5",
        submittedAt: "2026-11-24T14:35:00.000Z",
        verdict: "judged",
      },
      status: "judged",
    }),
    makeSubmission({
      cycleId: "cycle-2",
      draftId: "draft-sub-6",
      id: "sub-6",
      marketId: MARKET_A.id,
      status: "accepted",
    }),
  ];
  for (const submission of submissions) {
    await store.saveSubmission(submission);
  }
  await store.saveReward(
    makeReward("sub-1", "draft-sub-1", MARKET_A.id, 0.42),
  );
  await store.saveReward(
    makeReward("sub-2", "draft-sub-2", MARKET_A.id, 1.1, 0.5),
  );
  await store.saveReward(
    makeReward("sub-4", "draft-sub-4", MARKET_B.id, 2.0),
  );
  await store.saveReward(
    makeReward("sub-5", "draft-sub-5", MARKET_B.id, 0.75),
  );
  await store.saveReward(
    makeReward("sub-6", "draft-sub-6", MARKET_A.id, 0.1),
  );

  const longNote = `Bukti panjang untuk pasar B. ${"Fakta terverifikasi dari sumber terpercaya. ".repeat(10)}`;
  await store.saveDraft(
    makeDraft(
      "draft-sub-1",
      MARKET_A.id,
      "Komisi Pemilihan Zanara mengumumkan pemilu 31 Desember 2026.",
    ),
  );
  await store.saveDraft(
    makeDraft("draft-sub-2", MARKET_A.id, "Jadwal pemilu Zanara dikonfirmasi."),
  );
  await store.saveDraft(
    makeDraft("draft-sub-3", MARKET_B.id, "Draf yang ditolak Delphi."),
  );
  await store.saveDraft(makeDraft("draft-sub-4", MARKET_B.id, longNote));
  await store.saveDraft(
    makeDraft("draft-sub-5", MARKET_B.id, "Bukti kedua untuk pasar B."),
  );
  await store.saveDraft(
    makeDraft("draft-sub-6", MARKET_A.id, "Bukti ketiga untuk pasar A."),
  );

  await mkdir(join(dataDir, "costs"), { recursive: true });
  await writeFile(
    join(dataDir, "costs", "cycle-1.json"),
    JSON.stringify({
      cycleId: "cycle-1",
      modelCalls: 12,
      recordedAt: "2026-11-24T03:00:00.000Z",
      searchCalls: 9,
      searchCreditsUsed: 9,
    }),
    "utf-8",
  );
  await writeFile(
    join(dataDir, "costs", "cycle-2.json"),
    JSON.stringify({
      cycleId: "cycle-2",
      modelCalls: 20,
      recordedAt: "2026-11-24T15:00:00.000Z",
      searchCalls: 15,
      searchCreditsUsed: 15,
    }),
    "utf-8",
  );
  // A malformed cost file: skipped, and its cycle never appears.
  await writeFile(
    join(dataDir, "costs", "cycle-bad.json"),
    "{not json",
    "utf-8",
  );

  await mkdir(join(dataDir, "traces"), { recursive: true });
  const traceLine = (
    cycleId: string,
    step: string,
    marketId?: string,
  ): string =>
    JSON.stringify({
      cycleId,
      step,
      ts: "2026-11-24T02:00:00.000Z",
      ...(marketId !== undefined ? { marketId } : {}),
    });
  await writeFile(
    join(dataDir, "traces", "cycle-1.jsonl"),
    [
      traceLine("cycle-1", "market-start", MARKET_A.id),
      traceLine("cycle-1", "market-start", MARKET_B.id),
      traceLine("cycle-1", "market-start", MARKET_A.id),
      traceLine("cycle-1", "draft-created", MARKET_A.id),
      traceLine("cycle-1", "draft-created", MARKET_A.id),
      "this line is not json and must be skipped",
      "",
    ].join("\n"),
    "utf-8",
  );
  await writeFile(
    join(dataDir, "traces", "cycle-2.jsonl"),
    [
      traceLine("cycle-2", "market-start", MARKET_B.id),
      traceLine("cycle-2", "draft-created", MARKET_B.id),
      traceLine("cycle-2", "draft-created", MARKET_B.id),
      traceLine("cycle-2", "draft-created", MARKET_B.id),
      "",
    ].join("\n"),
    "utf-8",
  );
  // An orphan trace: a cycle with no cost record, no report, and no
  // run index entry.
  await writeFile(
    join(dataDir, "traces", "cycle-3.jsonl"),
    `${traceLine("cycle-3", "market-start", MARKET_A.id)}\n`,
    "utf-8",
  );

  await mkdir(join(dataDir, "reports"), { recursive: true });
  await writeFile(
    join(dataDir, "reports", "cycle-1.md"),
    "# Laporan siklus mining — cycle-1\n",
    "utf-8",
  );
  await writeFile(
    join(dataDir, "reports", "cycle-2.md"),
    "# Laporan siklus mining — cycle-2\n",
    "utf-8",
  );

  await mkdir(join(dataDir, "runs"), { recursive: true });
  await writeFile(
    join(dataDir, "runs", "index.jsonl"),
    [
      JSON.stringify({
        cycleId: "cycle-1",
        exitCode: 0,
        finishedAt: "2026-11-24T03:00:00.000Z",
        logPath: join(dataDir, "runs", "cycle-1.log"),
        startedAt: "2026-11-24T02:00:00.000Z",
        status: "ok",
      }),
      JSON.stringify({
        cycleId: "cycle-2",
        exitCode: 0,
        finishedAt: "2026-11-24T15:00:00.000Z",
        logPath: join(dataDir, "runs", "cycle-2.log"),
        startedAt: "2026-11-24T14:00:00.000Z",
        status: "ok",
      }),
      JSON.stringify({
        cycleId: "cycle-failed",
        exitCode: 1,
        finishedAt: "2026-11-25T02:05:00.000Z",
        logPath: join(dataDir, "runs", "cycle-failed.log"),
        startedAt: "2026-11-25T02:00:00.000Z",
        status: "failed",
      }),
      "this line is not json and must be skipped",
      "",
    ].join("\n"),
    "utf-8",
  );

  return dataDir;
}

describe("aggregateFinalSummary", () => {
  it("totals submissions, verdicts, markets, rewards, and costs", async () => {
    const dataDir = await seedDataDir();

    const summary = await aggregateFinalSummary(dataDir, {
      now: () => new Date("2026-12-12T00:00:00.000Z"),
    });

    expect(summary.generatedAt).toBe("2026-12-12T00:00:00.000Z");
    expect(summary.totals.submissions).toBe(6);
    expect(summary.totals.accepted).toBe(3);
    expect(summary.totals.judged).toBe(2);
    expect(summary.totals.rejected).toBe(1);
    expect(summary.totals.marketsCovered).toBe(2);
    expect(summary.totals.judgmentReward).toBeCloseTo(4.37, 10);
    expect(summary.totals.settlementReward).toBeCloseTo(0.5, 10);
    expect(summary.totals.totalReward).toBeCloseTo(4.87, 10);
    expect(summary.totals.modelCalls).toBe(32);
    expect(summary.totals.searchCalls).toBe(24);
    expect(summary.totals.searchCreditsUsed).toBe(24);
    expect(summary.totals.cycles).toBe(4);
    expect(summary.totals.failedCycles).toBe(2);
  });

  it("skips a cost record with a non-finite number instead of poisoning the totals", async () => {
    const dataDir = await seedDataDir();
    // 1e999 is valid JSON and parses to Infinity: a hand-edited
    // cost file can carry one, and it must not reach the totals.
    await writeFile(
      join(dataDir, "costs", "cycle-huge.json"),
      '{"cycleId":"cycle-huge","modelCalls":1e999,' +
        '"recordedAt":"2026-11-24T15:00:00.000Z","searchCalls":1,' +
        '"searchCreditsUsed":1}',
      "utf-8",
    );

    const summary = await aggregateFinalSummary(dataDir);

    expect(summary.totals.modelCalls).toBe(32);
    expect(summary.totals.searchCalls).toBe(24);
    expect(summary.totals.searchCreditsUsed).toBe(24);
    expect(summary.totals.cycles).toBe(4);
  });

  it("lists markets covered with submission counts and rewards", async () => {
    const dataDir = await seedDataDir();

    const summary = await aggregateFinalSummary(dataDir);

    expect(summary.markets).toHaveLength(2);
    const rowA = summary.markets.find(
      (row) => row.marketId === MARKET_A.id,
    )!;
    expect(rowA.question).toBe(QUESTION_A);
    expect(rowA.submissions).toBe(3);
    expect(rowA.judgmentReward).toBeCloseTo(1.62, 10);
    expect(rowA.settlementReward).toBeCloseTo(0.5, 10);
    const rowB = summary.markets.find(
      (row) => row.marketId === MARKET_B.id,
    )!;
    expect(rowB.question).toBe(QUESTION_B);
    expect(rowB.submissions).toBe(3);
    expect(rowB.judgmentReward).toBeCloseTo(2.75, 10);
    expect(rowB.settlementReward).toBe(0);
  });

  it("ranks the best evidence by judgment reward, top 5", async () => {
    const dataDir = await seedDataDir();

    const summary = await aggregateFinalSummary(dataDir);

    expect(summary.bestEvidence.map((entry) => entry.submissionId)).toEqual([
      "sub-4",
      "sub-2",
      "sub-5",
      "sub-1",
      "sub-6",
    ]);
    const best = summary.bestEvidence[0]!;
    expect(best.marketId).toBe(MARKET_B.id);
    expect(best.question).toBe(QUESTION_B);
    expect(best.judgmentReward).toBe(2);
    // The long note is truncated to a 200-character excerpt.
    expect(best.noteExcerpt.length).toBe(201);
    expect(best.noteExcerpt.endsWith("…")).toBe(true);
    expect(best.links).toEqual([
      "https://example.invalid/sources/draft-sub-4",
    ]);
    const second = summary.bestEvidence[1]!;
    expect(second.noteExcerpt).toBe(
      "Jadwal pemilu Zanara dikonfirmasi.",
    );
    expect(second.settlementReward).toBeCloseTo(0.5, 10);
  });

  it("builds a per-cycle table from costs, traces, and submissions", async () => {
    const dataDir = await seedDataDir();

    const summary = await aggregateFinalSummary(dataDir);

    expect(summary.cycles.map((row) => row.cycleId)).toEqual([
      "cycle-1",
      "cycle-2",
      "cycle-failed",
      "cycle-3",
    ]);
    const first = summary.cycles[0]!;
    expect(first).toMatchObject({
      drafts: 2,
      judgmentReward: 1.52,
      markets: 2,
      modelCalls: 12,
      searchCalls: 9,
      settlementReward: 0.5,
      status: "ok",
      submissions: 3,
    });
    const second = summary.cycles[1]!;
    expect(second).toMatchObject({
      drafts: 3,
      judgmentReward: 2.85,
      markets: 1,
      modelCalls: 20,
      searchCalls: 15,
      settlementReward: 0,
      status: "ok",
      submissions: 3,
    });
    // The failed cycle has no trace and no cost record: markets fall
    // back to its (zero) submissions, drafts and costs are unknown.
    const failed = summary.cycles[2]!;
    expect(failed).toMatchObject({
      drafts: null,
      markets: 0,
      modelCalls: null,
      searchCalls: null,
      status: "failed",
      submissions: 0,
    });
    // The orphan trace: markets and drafts come from the trace, but
    // there is no cost record and no run index entry.
    const orphan = summary.cycles[3]!;
    expect(orphan).toMatchObject({
      drafts: 0,
      markets: 1,
      modelCalls: null,
      searchCalls: null,
      status: "unknown",
      submissions: 0,
    });
  });

  it("reports failed cycles and cycles with no report or cost record", async () => {
    const dataDir = await seedDataDir();

    const summary = await aggregateFinalSummary(dataDir);

    expect(summary.failures).toHaveLength(2);
    const failed = summary.failures.find(
      (entry) => entry.cycleId === "cycle-failed",
    )!;
    expect(failed.kind).toBe("failed");
    expect(failed.exitCode).toBe(1);
    expect(failed.logPath).toBe(join(dataDir, "runs", "cycle-failed.log"));
    const unknown = summary.failures.find(
      (entry) => entry.cycleId === "cycle-3",
    )!;
    expect(unknown.kind).toBe("unknown");
    // The completed cycles have reports and cost records: not failures.
    expect(
      summary.failures.some((entry) => entry.cycleId === "cycle-1"),
    ).toBe(false);
    expect(
      summary.failures.some((entry) => entry.cycleId === "cycle-2"),
    ).toBe(false);
    // The malformed cost file never created a cycle.
    expect(
      summary.cycles.some((row) => row.cycleId === "cycle-bad"),
    ).toBe(false);
  });

  it("aggregates an empty data dir to zeros without throwing", async () => {
    const dataDir = await makeTempDir();

    const summary = await aggregateFinalSummary(dataDir);

    expect(summary.totals.submissions).toBe(0);
    expect(summary.totals.marketsCovered).toBe(0);
    expect(summary.totals.totalReward).toBe(0);
    expect(summary.totals.cycles).toBe(0);
    expect(summary.markets).toEqual([]);
    expect(summary.bestEvidence).toEqual([]);
    expect(summary.cycles).toEqual([]);
    expect(summary.failures).toEqual([]);
  });
});
