import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { MemoryStore } from "../src/memory/store.js";
import { syncSubmissionOutcomes } from "../src/submit/outcomes.js";
import type { SubmissionRecord } from "../src/submit/types.js";

let tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vgen19-outcomes-test-"));
  tempDirs.push(dir);
  return dir;
}

async function makeStore(): Promise<MemoryStore> {
  return new MemoryStore(await makeTempDir());
}

afterEach(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { force: true, recursive: true });
  }
  tempDirs = [];
});

const MARKET_A = "0x0000000000000000000000000000000000000001";
const MARKET_B = "0x0000000000000000000000000000000000000002";
const FIXED_NOW = new Date("2026-11-24T06:00:00.000Z");

function acceptedRecord(overrides: Partial<SubmissionRecord> = {}): SubmissionRecord {
  return {
    cycleId: "cycle-1",
    draftId: "draft-1",
    id: "sub-live-1",
    marketId: MARKET_A,
    receipt: {
      draftId: "draft-1",
      marketId: MARKET_A,
      submissionId: "sub-live-1",
      submittedAt: "2026-11-24T00:05:00.000Z",
      verdict: "accepted",
    },
    recordedAt: "2026-11-24T00:05:00.000Z",
    status: "accepted",
    ...overrides,
  };
}

/** A live submission in the shape the evidence API returns (SDK). */
function liveSubmission(overrides: Record<string, unknown> = {}) {
  const marketOverrides =
    (overrides["market"] as Record<string, unknown> | undefined) ?? {};
  const rest = { ...overrides };
  delete rest["market"];
  return {
    agentId: "Vgen19",
    createdAt: "2026-11-24T00:05:00.000Z",
    files: [],
    id: "sub-live-1",
    links: ["https://example.invalid/source-1"],
    markets: [
      {
        bounty: null,
        marketAddress: MARKET_A,
        reason: null,
        settlementUpTo: null,
        status: "queued",
        verdict: null,
        ...marketOverrides,
      },
    ],
    note: "Test evidence note.",
    status: "queued",
    ...rest,
  };
}

describe("syncSubmissionOutcomes", () => {
  it("updates an accepted submission once Delphi judges it, recording the reward", async () => {
    const store = await makeStore();
    await store.saveSubmission(acceptedRecord());
    const seenIds: string[] = [];
    const getSubmission = async (id: string): Promise<unknown> => {
      seenIds.push(id);
      return liveSubmission({
        market: {
          bounty: { amount: "420000", state: "held" },
          status: "judged",
          verdict: "accepted",
        },
        status: "judged",
      });
    };

    const result = await syncSubmissionOutcomes(store, getSubmission, {
      now: () => FIXED_NOW,
    });

    expect(result).toEqual({ checked: 1, failed: [], unchanged: 0, updated: 1 });
    expect(seenIds).toEqual(["sub-live-1"]);
    const updated = await store.loadSubmission("sub-live-1");
    expect(updated?.status).toBe("judged");
    expect(updated?.receipt.verdict).toBe("judged");
    expect(updated?.receipt.reward).toEqual({
      currency: "USDC.e",
      judgment: 0.42,
    });
    const reward = await store.loadReward("sub-live-1");
    expect(reward).toMatchObject({
      currency: "USDC.e",
      draftId: "draft-1",
      judgment: 0.42,
      marketId: MARKET_A,
      submissionId: "sub-live-1",
    });
  });

  it("leaves a still-queued submission untouched", async () => {
    const store = await makeStore();
    await store.saveSubmission(acceptedRecord());

    const result = await syncSubmissionOutcomes(
      store,
      async () => liveSubmission({ status: "judging" }),
      { now: () => FIXED_NOW },
    );

    expect(result).toEqual({ checked: 1, failed: [], unchanged: 1, updated: 0 });
    const untouched = await store.loadSubmission("sub-live-1");
    expect(untouched?.status).toBe("accepted");
    expect(await store.loadReward("sub-live-1")).toBeUndefined();
  });

  it("marks an accepted submission rejected when Delphi rejects it", async () => {
    const store = await makeStore();
    await store.saveSubmission(acceptedRecord());

    const result = await syncSubmissionOutcomes(
      store,
      async () =>
        liveSubmission({
          market: { reason: "Evidence does not move the forecaster." },
          status: "rejected",
        }),
      { now: () => FIXED_NOW },
    );

    expect(result.updated).toBe(1);
    const updated = await store.loadSubmission("sub-live-1");
    expect(updated?.status).toBe("rejected");
    expect(updated?.receipt.rationale).toBe(
      "Evidence does not move the forecaster.",
    );
  });

  it("does not re-check submissions that are already judged or rejected", async () => {
    const store = await makeStore();
    await store.saveSubmission(
      acceptedRecord({
        id: "sub-judged",
        receipt: {
          draftId: "draft-1",
          marketId: MARKET_A,
          reward: { currency: "USDC.e", judgment: 0.42 },
          submissionId: "sub-judged",
          submittedAt: "2026-11-24T00:05:00.000Z",
          verdict: "judged",
        },
        status: "judged",
      }),
    );
    await store.saveSubmission(
      acceptedRecord({
        draftId: "draft-2",
        id: "sub-rejected",
        marketId: MARKET_B,
        receipt: {
          draftId: "draft-2",
          marketId: MARKET_B,
          rationale: "Duplicate.",
          submissionId: "sub-rejected",
          submittedAt: "2026-11-24T00:05:00.000Z",
          verdict: "rejected",
        },
        status: "rejected",
      }),
    );
    let calls = 0;
    const result = await syncSubmissionOutcomes(store, async () => {
      calls += 1;
      return liveSubmission();
    });

    expect(result).toEqual({ checked: 0, failed: [], unchanged: 0, updated: 0 });
    expect(calls).toBe(0);
  });

  it("records one failure and keeps checking the rest", async () => {
    const store = await makeStore();
    await store.saveSubmission(acceptedRecord());
    await store.saveSubmission(
      acceptedRecord({
        draftId: "draft-2",
        id: "sub-live-2",
        marketId: MARKET_B,
        receipt: {
          draftId: "draft-2",
          marketId: MARKET_B,
          submissionId: "sub-live-2",
          submittedAt: "2026-11-24T00:05:00.000Z",
          verdict: "accepted",
        },
      }),
    );
    const getSubmission = async (id: string): Promise<unknown> => {
      if (id === "sub-live-1") {
        throw new Error("Delphi down");
      }
      return liveSubmission({
        id: "sub-live-2",
        market: {
          bounty: { amount: "100000", state: "paid" },
          marketAddress: MARKET_B,
        },
        status: "judged",
      });
    };

    const result = await syncSubmissionOutcomes(store, getSubmission, {
      now: () => FIXED_NOW,
    });

    expect(result.checked).toBe(2);
    expect(result.updated).toBe(1);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.submissionId).toBe("sub-live-1");
    expect(result.failed[0]?.message).toMatch(/Delphi down/);
    const second = await store.loadSubmission("sub-live-2");
    expect(second?.status).toBe("judged");
  });

  it("records a parse failure instead of crashing", async () => {
    const store = await makeStore();
    await store.saveSubmission(acceptedRecord());

    const result = await syncSubmissionOutcomes(store, async () => ({
      nope: true,
    }));

    expect(result.checked).toBe(1);
    expect(result.updated).toBe(0);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.submissionId).toBe("sub-live-1");
    const untouched = await store.loadSubmission("sub-live-1");
    expect(untouched?.status).toBe("accepted");
  });

  it("keeps an existing settlement reward when adding the judgment", async () => {
    const store = await makeStore();
    await store.saveSubmission(acceptedRecord());
    await store.saveReward({
      currency: "USDC.e",
      draftId: "draft-1",
      marketId: MARKET_A,
      recordedAt: "2026-11-24T01:00:00.000Z",
      settlement: 0.1,
      submissionId: "sub-live-1",
    });

    await syncSubmissionOutcomes(
      store,
      async () =>
        liveSubmission({
          market: { bounty: { amount: "420000", state: "held" } },
          status: "judged",
        }),
      { now: () => FIXED_NOW },
    );

    const reward = await store.loadReward("sub-live-1");
    expect(reward?.judgment).toBe(0.42);
    expect(reward?.settlement).toBe(0.1);
  });
});
