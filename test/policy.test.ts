import { describe, expect, it } from "vitest";

import {
  atCycleSubmissionCap,
  atMarketSubmissionCap,
  DEFAULT_CYCLE_TIME_BUDGET_MINUTES,
  DEFAULT_MAX_MARKETS_PER_CYCLE,
  DEFAULT_MAX_SUBMISSIONS_PER_CYCLE,
  DEFAULT_MODEL_CALL_BUDGET,
  DEFAULT_REVIEW_PASS_THRESHOLD,
  MAX_SUBMISSIONS_PER_MARKET,
  pastEvidenceCutoff,
} from "../src/policy/index.js";

describe("policy limits", () => {
  it("carries the spec's numbers in one place", () => {
    expect(MAX_SUBMISSIONS_PER_MARKET).toBe(3);
    expect(DEFAULT_MAX_SUBMISSIONS_PER_CYCLE).toBe(5);
    expect(DEFAULT_MODEL_CALL_BUDGET).toBe(50);
    expect(DEFAULT_MAX_MARKETS_PER_CYCLE).toBe(5);
    expect(DEFAULT_REVIEW_PASS_THRESHOLD).toBe(0.7);
    expect(DEFAULT_CYCLE_TIME_BUDGET_MINUTES).toBe(45);
  });

  it("atMarketSubmissionCap trips at 3 submissions", () => {
    expect(atMarketSubmissionCap(2)).toBe(false);
    expect(atMarketSubmissionCap(3)).toBe(true);
    expect(atMarketSubmissionCap(4)).toBe(true);
  });

  it("atCycleSubmissionCap trips at the configured limit", () => {
    expect(atCycleSubmissionCap(4, 5)).toBe(false);
    expect(atCycleSubmissionCap(5, 5)).toBe(true);
  });

  it("pastEvidenceCutoff trips only for a present, parsable, past cutoff", () => {
    const now = new Date("2026-11-20T10:00:00.000Z");
    expect(pastEvidenceCutoff("2026-11-19T10:00:00.000Z", now)).toBe(true);
    expect(pastEvidenceCutoff("2026-11-20T10:00:00.000Z", now)).toBe(true);
    expect(pastEvidenceCutoff("2026-12-30T00:00:00.000Z", now)).toBe(false);
    expect(pastEvidenceCutoff(undefined, now)).toBe(false);
    expect(pastEvidenceCutoff("not a date", now)).toBe(false);
  });
});
