import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { MemoryStore } from "../src/memory/store.js";
import type {
  Approval,
  RewardRecord,
  SubmissionRecord,
  SubmissionRefusal,
} from "../src/submit/types.js";

let tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vgen19-submit-memory-test-"));
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

function makeSubmission(
  overrides: Partial<SubmissionRecord> = {},
): SubmissionRecord {
  return {
    cycleId: "cycle-1",
    draftId: "draft-1",
    id: "sub-1",
    marketId: MARKET_A,
    receipt: {
      draftId: "draft-1",
      marketId: MARKET_A,
      rationale: "Evidence moved the forecaster.",
      reward: { currency: "USDC", judgment: 0.42 },
      submissionId: "sub-1",
      submittedAt: "2026-11-20T16:00:00.000Z",
      verdict: "accepted",
    },
    recordedAt: "2026-11-20T16:00:00.000Z",
    status: "accepted",
    ...overrides,
  };
}

describe("MemoryStore submissions", () => {
  it("persists submissions across store instances (round-trip)", async () => {
    const dataDir = await makeTempDir();
    const submission = makeSubmission();

    const writer = new MemoryStore(dataDir);
    await writer.saveSubmission(submission);

    const reader = new MemoryStore(dataDir);
    expect(await reader.loadSubmission("sub-1")).toEqual(submission);
    expect(await reader.loadSubmissions()).toEqual([submission]);
  });

  it("loads undefined for an unknown submission id", async () => {
    const dataDir = await makeTempDir();
    const store = new MemoryStore(dataDir);

    expect(await store.loadSubmission("no-such-submission")).toBeUndefined();
    expect(await store.loadSubmissions()).toEqual([]);
  });

  it("filters submissions by market and by cycle", async () => {
    const dataDir = await makeTempDir();
    const store = new MemoryStore(dataDir);
    await store.saveSubmission(makeSubmission({ id: "sub-1" }));
    await store.saveSubmission(
      makeSubmission({
        cycleId: "cycle-2",
        draftId: "draft-2",
        id: "sub-2",
        receipt: {
          draftId: "draft-2",
          marketId: MARKET_A,
          submissionId: "sub-2",
          submittedAt: "2026-11-20T17:00:00.000Z",
          verdict: "accepted",
        },
      }),
    );
    await store.saveSubmission(
      makeSubmission({
        draftId: "draft-3",
        id: "sub-3",
        marketId: MARKET_B,
        receipt: {
          draftId: "draft-3",
          marketId: MARKET_B,
          submissionId: "sub-3",
          submittedAt: "2026-11-20T17:00:00.000Z",
          verdict: "accepted",
        },
      }),
    );

    expect(
      (await store.loadSubmissions({ marketId: MARKET_A })).map((s) => s.id),
    ).toEqual(["sub-1", "sub-2"]);
    expect(
      (await store.loadSubmissions({ cycleId: "cycle-2" })).map((s) => s.id),
    ).toEqual(["sub-2"]);
    expect(
      (await store.loadSubmissions({ marketId: MARKET_B })).map((s) => s.id),
    ).toEqual(["sub-3"]);
    expect(await store.loadSubmissions()).toHaveLength(3);
  });
});

describe("MemoryStore approvals", () => {
  it("persists an approval per draft (round-trip)", async () => {
    const dataDir = await makeTempDir();
    const approval: Approval = {
      approvedAt: "2026-11-20T16:00:00.000Z",
      approvedBy: "human",
      draftId: "draft-1",
      note: "Looks good.",
    };

    const writer = new MemoryStore(dataDir);
    await writer.saveApproval(approval);

    const reader = new MemoryStore(dataDir);
    expect(await reader.loadApproval("draft-1")).toEqual(approval);
    expect(await reader.loadApproval("draft-2")).toBeUndefined();
  });
});

describe("MemoryStore rewards", () => {
  it("persists rewards keyed by submission id (round-trip)", async () => {
    const dataDir = await makeTempDir();
    const reward: RewardRecord = {
      currency: "USDC",
      draftId: "draft-1",
      judgment: 0.42,
      marketId: MARKET_A,
      recordedAt: "2026-11-20T16:00:00.000Z",
      submissionId: "sub-1",
    };

    const writer = new MemoryStore(dataDir);
    await writer.saveReward(reward);

    const reader = new MemoryStore(dataDir);
    expect(await reader.loadReward("sub-1")).toEqual(reward);
    expect(await reader.loadRewards()).toEqual([reward]);
    expect(await reader.loadReward("sub-2")).toBeUndefined();
  });

  it("re-saving a reward updates it without duplicating", async () => {
    const dataDir = await makeTempDir();
    const store = new MemoryStore(dataDir);
    await store.saveReward({
      currency: "USDC",
      draftId: "draft-1",
      judgment: 0.42,
      marketId: MARKET_A,
      recordedAt: "2026-11-20T16:00:00.000Z",
      submissionId: "sub-1",
    });

    await store.saveReward({
      currency: "USDC",
      draftId: "draft-1",
      judgment: 0.42,
      marketId: MARKET_A,
      recordedAt: "2026-11-21T16:00:00.000Z",
      settlement: 1.1,
      submissionId: "sub-1",
    });

    const rewards = await store.loadRewards();
    expect(rewards).toHaveLength(1);
    expect(rewards[0]!.settlement).toBe(1.1);
    expect(rewards[0]!.judgment).toBe(0.42);
  });
});

describe("MemoryStore refusals", () => {
  it("persists refused attempts in first-recorded order", async () => {
    const dataDir = await makeTempDir();
    const store = new MemoryStore(dataDir);
    const refusal: SubmissionRefusal = {
      cycleId: "cycle-1",
      draftId: "draft-1",
      id: "refusal-1",
      marketId: MARKET_A,
      message: "Market already has 3 submissions.",
      reason: "cap-market",
      refusedAt: "2026-11-20T16:00:00.000Z",
    };

    await store.recordRefusal(refusal);

    const reader = new MemoryStore(dataDir);
    expect(await reader.loadRefusals()).toEqual([refusal]);
    expect(await reader.loadRefusals({ marketId: MARKET_B })).toEqual([]);
    expect(
      await reader.loadRefusals({ marketId: MARKET_A }),
    ).toHaveLength(1);
  });

  it("loads an empty list when nothing was refused yet", async () => {
    const dataDir = await makeTempDir();
    const store = new MemoryStore(dataDir);

    expect(await store.loadRefusals()).toEqual([]);
  });
});
