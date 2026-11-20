import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  cycleReportPath,
  formatCycleReport,
  formatCycleSummaryLine,
  writeCycleReport,
  type CycleSummary,
} from "../src/cycle/report.js";

let tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vgen19-cycle-report-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { force: true, recursive: true });
  }
  tempDirs = [];
});

function makeSummary(overrides: Partial<CycleSummary> = {}): CycleSummary {
  return {
    budgetExhausted: false,
    timeBudgetExhausted: false,
    cost: {
      cycleId: "cycle-test-1",
      modelCalls: 12,
      recordedAt: "2026-11-20T10:05:00.000Z",
      searchCalls: 9,
      searchCreditsUsed: 0,
    },
    costPath: "/data/costs/cycle-test-1.json",
    cycleId: "cycle-test-1",
    drafts: [
      {
        draftId: "draft-1",
        marketId: "market-1",
        reviewPassed: true,
        reviewScore: 1,
      },
    ],
    dryRun: false,
    errors: [],
    finishedAt: "2026-11-20T10:05:00.000Z",
    marketsChecked: ["market-1", "market-2", "market-3"],
    marketsPicked: ["market-1", "market-2"],
    marketsSkipped: [{ marketId: "market-3", reason: "not-open" }],
    refusals: [
      { draftId: "draft-2", marketId: "market-2", reason: "gate" },
    ],
    reportPath: "/data/reports/cycle-test-1.md",
    rewardsSoFar: { judgment: 2.5, settlement: 1, total: 3.5 },
    startedAt: "2026-11-20T10:00:00.000Z",
    status: "completed",
    submissions: [
      {
        draftId: "draft-1",
        marketId: "market-1",
        submissionId: "submission-1",
        verdict: "accepted",
      },
    ],
    tracePath: "/data/traces/cycle-test-1.jsonl",
    ...overrides,
  };
}

describe("formatCycleReport", () => {
  it("reports markets checked, drafts, submissions, refusals, rewards, and cost", () => {
    const report = formatCycleReport(makeSummary());

    expect(report).toContain("cycle-test-1");
    expect(report).toContain("2026-11-20T10:00:00.000Z");
    expect(report).toContain("2026-11-20T10:05:00.000Z");
    // Markets checked: count plus list, including the skipped one.
    expect(report).toContain("market-1");
    expect(report).toContain("market-2");
    expect(report).toContain("market-3");
    // Drafts with their review scores.
    expect(report).toContain("draft-1");
    expect(report).toContain("1.00");
    // Submissions with their receipt verdicts.
    expect(report).toContain("submission-1");
    expect(report).toContain("accepted");
    // Refusals with reasons.
    expect(report).toContain("draft-2");
    expect(report).toContain("gate");
    // Rewards so far: judgment plus settlement totals.
    expect(report).toContain("2.5");
    expect(report).toContain("3.5");
    // Rank/leaderboard context is unavailable until ticket 08.
    expect(report).toMatch(/leaderboard/i);
    expect(report).toMatch(/belum tersedia/i);
    // Cost summary.
    expect(report).toContain("12");
    expect(report).toContain("9");
  });

  it("says when the cycle was a dry run and when the budget ran out", () => {
    const report = formatCycleReport(
      makeSummary({ budgetExhausted: true, dryRun: true }),
    );

    expect(report).toMatch(/dry-run/i);
    expect(report).toMatch(/anggaran/i);
  });

  it("says when the cycle stopped on its time budget", () => {
    const report = formatCycleReport(
      makeSummary({ timeBudgetExhausted: true }),
    );

    expect(report).toMatch(/batas waktu siklus habis/i);
  });

  it("lists errors when the cycle recorded any", () => {
    const report = formatCycleReport(
      makeSummary({
        errors: ["market-2: all searches failed"],
        status: "interrupted",
      }),
    );

    expect(report).toContain("market-2: all searches failed");
    expect(report).toMatch(/terganggu|interrupted/i);
  });

  it("reports an empty cycle as a normal outcome, not a failure", () => {
    const report = formatCycleReport(
      makeSummary({
        drafts: [],
        marketsChecked: [],
        marketsPicked: [],
        marketsSkipped: [],
        refusals: [],
        rewardsSoFar: { judgment: 0, settlement: 0, total: 0 },
        submissions: [],
      }),
    );

    expect(report).toContain("cycle-test-1");
    expect(report).toMatch(/0/);
    expect(report).not.toMatch(/failed|gagal/i);
  });
});

describe("formatCycleSummaryLine", () => {
  it("summarizes the cycle in one paragraph", () => {
    const line = formatCycleSummaryLine(makeSummary());

    expect(line).not.toContain("\n");
    expect(line).toContain("cycle-test-1");
    expect(line).toContain("3 pasar");
    expect(line).toContain("1 submission");
    expect(line).toContain("3.5");
    expect(line).toContain("/data/reports/cycle-test-1.md");
  });

  it("notes when the cycle stopped on its time budget", () => {
    const line = formatCycleSummaryLine(
      makeSummary({ timeBudgetExhausted: true }),
    );

    expect(line).toMatch(/batas waktu siklus habis/i);
  });
});

describe("writeCycleReport", () => {
  it("writes the report to reports/<cycle-id>.md", async () => {
    const dataDir = await makeTempDir();
    const summary = makeSummary({
      costPath: join(dataDir, "costs", "cycle-test-1.json"),
      reportPath: cycleReportPath(dataDir, "cycle-test-1"),
      tracePath: join(dataDir, "traces", "cycle-test-1.jsonl"),
    });

    const path = await writeCycleReport(dataDir, summary);

    expect(path).toBe(cycleReportPath(dataDir, "cycle-test-1"));
    const stored = await readFile(path, "utf-8");
    expect(stored).toContain("cycle-test-1");
    expect(stored).toContain("draft-1");
  });

  it("refuses a cycle id that would escape the data dir", async () => {
    const dataDir = await makeTempDir();

    expect(() => cycleReportPath(dataDir, "../../x")).toThrow(/cycle id/i);
    expect(() => cycleReportPath(dataDir, "")).toThrow(/cycle id/i);
  });
});
