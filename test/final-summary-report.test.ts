import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  finalSummaryPath,
  formatFinalSummary,
  formatFinalSummaryLine,
  writeFinalSummary,
} from "../src/summary/report.js";
import type { FinalSummary } from "../src/summary/types.js";

let tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vgen19-final-summary-report-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { force: true, recursive: true });
  }
  tempDirs = [];
});

const MARKET_A = "0x0000000000000000000000000000000000000001";
const MARKET_B = "0x0000000000000000000000000000000000000002";

function makeSummary(overrides: Partial<FinalSummary> = {}): FinalSummary {
  return {
    bestEvidence: [
      {
        judgmentReward: 2,
        links: ["https://example.invalid/sources/draft-sub-4"],
        marketId: MARKET_B,
        noteExcerpt: "Bukti panjang untuk pasar B.",
        question: "Will token B launch before 2027?",
        settlementReward: 0,
        submissionId: "sub-4",
      },
      {
        judgmentReward: 1.1,
        links: ["https://example.invalid/sources/draft-sub-2"],
        marketId: MARKET_A,
        noteExcerpt: "Jadwal pemilu Zanara dikonfirmasi.",
        question:
          "Will the Republic of Zanara hold a general election before 31 December 2026?",
        settlementReward: 0.5,
        submissionId: "sub-2",
      },
    ],
    cycles: [
      {
        cycleId: "cycle-1",
        drafts: 2,
        judgmentReward: 1.52,
        markets: 2,
        modelCalls: 12,
        searchCalls: 9,
        settlementReward: 0.5,
        status: "ok",
        submissions: 3,
      },
      {
        cycleId: "cycle-failed",
        drafts: null,
        judgmentReward: 0,
        markets: 0,
        modelCalls: null,
        searchCalls: null,
        settlementReward: 0,
        status: "failed",
        submissions: 0,
      },
    ],
    failures: [
      {
        cycleId: "cycle-failed",
        exitCode: 1,
        kind: "failed",
        logPath: "/data/runs/cycle-failed.log",
        reason: "siklus gagal dengan exit code 1",
        startedAt: "2026-11-25T02:00:00.000Z",
      },
    ],
    generatedAt: "2026-12-12T00:00:00.000Z",
    markets: [
      {
        judgmentReward: 2.75,
        marketId: MARKET_B,
        question: "Will token B launch before 2027?",
        settlementReward: 0,
        submissions: 3,
      },
      {
        judgmentReward: 1.62,
        marketId: MARKET_A,
        question:
          "Will the Republic of Zanara hold a general election before 31 December 2026?",
        settlementReward: 0.5,
        submissions: 3,
      },
    ],
    totals: {
      accepted: 3,
      cycles: 2,
      failedCycles: 1,
      judged: 2,
      judgmentReward: 4.37,
      marketsCovered: 2,
      modelCalls: 12,
      rejected: 1,
      searchCalls: 9,
      searchCreditsUsed: 9,
      settlementReward: 0.5,
      submissions: 6,
      totalReward: 4.87,
    },
    ...overrides,
  };
}

function emptySummary(): FinalSummary {
  return {
    bestEvidence: [],
    cycles: [],
    failures: [],
    generatedAt: "2026-12-12T00:00:00.000Z",
    markets: [],
    totals: {
      accepted: 0,
      cycles: 0,
      failedCycles: 0,
      judged: 0,
      judgmentReward: 0,
      marketsCovered: 0,
      modelCalls: 0,
      rejected: 0,
      searchCalls: 0,
      searchCreditsUsed: 0,
      settlementReward: 0,
      submissions: 0,
      totalReward: 0,
    },
  };
}

describe("formatFinalSummary", () => {
  it("renders totals, markets, best evidence, cycles, and failures in Indonesian", () => {
    const report = formatFinalSummary(makeSummary());

    expect(report).toContain("# Ringkasan akhir kompetisi");
    expect(report).toContain("Dibuat: 2026-12-12T00:00:00.000Z");
    expect(report).toContain("6 submission");
    expect(report).toContain("3 diterima, 2 dinilai, 1 ditolak");
    expect(report).toContain("2 pasar");
    expect(report).toContain("4.87 USDC");
    expect(report).toContain("Will token B launch before 2027?");
    // Rank/leaderboard context is unavailable until ticket 08.
    expect(report).toMatch(/leaderboard/i);
    expect(report).toMatch(/belum tersedia/i);
    expect(report).toContain("Bukti panjang untuk pasar B.");
    expect(report).toContain("https://example.invalid/sources/draft-sub-4");
    expect(report).toContain("cycle-1");
    expect(report).toContain("cycle-failed");
    expect(report).toContain("siklus gagal dengan exit code 1");
    expect(report).toContain("/data/runs/cycle-failed.log");
    // Unknown counts render as n/a, never as a guessed zero.
    expect(report).toContain("n/a");
  });

  it("renders an empty summary without crashing", () => {
    const report = formatFinalSummary(emptySummary());

    expect(report).toContain("0 submission");
    expect(report).toContain("Tidak ada pasar yang tercakup.");
    expect(report).toContain("Belum ada bukti yang mendapat reward judgment.");
    expect(report).toContain("Tidak ada siklus yang tercatat.");
    expect(report).toContain("Tidak ada kegagalan.");
  });
});

describe("formatFinalSummaryLine", () => {
  it("summarizes the totals in one paragraph", () => {
    const line = formatFinalSummaryLine(makeSummary());

    expect(line).toContain("6 submission");
    expect(line).toContain("2 pasar");
    expect(line).toContain("4.87 USDC");
    expect(line).toContain("2 siklus");
    expect(line).toContain("1 gagal");
    expect(line).toContain("sub-4");
  });
});

describe("writeFinalSummary", () => {
  it("writes <data-dir>/final-summary.md and returns its path", async () => {
    const dataDir = await makeTempDir();
    const summary = makeSummary();

    const path = await writeFinalSummary(dataDir, summary);

    expect(path).toBe(join(dataDir, "final-summary.md"));
    expect(path).toBe(finalSummaryPath(dataDir));
    const written = await readFile(path, "utf-8");
    expect(written).toBe(formatFinalSummary(summary));
  });
});
