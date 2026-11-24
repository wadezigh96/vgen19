import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { DelphiAdapter } from "../src/delphi/adapter.js";
import { fixtureMarkets } from "../src/delphi/fixtures.js";
import { STUB_IDENTITY } from "../src/delphi/stub.js";
import type { AgentIdentity, Market } from "../src/delphi/types.js";
import type { EvidenceDraft } from "../src/draft/types.js";
import { MemoryStore } from "../src/memory/store.js";
import { approveDraft } from "../src/submit/approvals.js";
import { parseSubmissionReceipt, ReceiptParseError } from "../src/submit/receipt.js";
import { recordSettlementReward } from "../src/submit/rewards.js";
import {
  createDraftSubmitter,
  submitDraft,
  type SubmitDraftDeps,
} from "../src/submit/submitter.js";
import {
  SubmissionRefusedError,
  SubmissionRejectedError,
  type SubmissionRecord,
} from "../src/submit/types.js";

let tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vgen19-submit-test-"));
  tempDirs.push(dir);
  return dir;
}

async function makeStore(): Promise<MemoryStore> {
  return new MemoryStore(await makeTempDir());
}

/**
 * A store whose first `saveSubmission` throws, simulating a crash
 * between Delphi recording the submission and the memory write.
 * Later writes succeed, so a retry can complete.
 */
class CrashOnceStore extends MemoryStore {
  private crashed = false;

  override async saveSubmission(
    submission: SubmissionRecord,
  ): Promise<void> {
    if (!this.crashed) {
      this.crashed = true;
      throw new Error("simulated crash: disk full");
    }
    return super.saveSubmission(submission);
  }
}

afterEach(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { force: true, recursive: true });
  }
  tempDirs = [];
});

const MARKET_A = "0x0000000000000000000000000000000000000001";
const FIXED_NOW = new Date("2026-11-20T16:00:00.000Z");

function makeDraft(overrides: Partial<EvidenceDraft> = {}): EvidenceDraft {
  return {
    createdAt: "2026-11-20T15:00:00.000Z",
    files: [],
    id: "draft-1",
    links: [
      { title: "Zanara election date set", url: "https://example.com/zanara" },
    ],
    marketId: MARKET_A,
    note: "Zanara set its general election for 15 December 2026.",
    status: "approved",
    ...overrides,
  };
}

/**
 * Fake Delphi API for submitter tests: records every submission call
 * and answers with queued raw receipts (or a canned accepted receipt
 * when the queue is empty). No network anywhere.
 */
class RecordingDelphiAdapter implements DelphiAdapter {
  readonly identity: AgentIdentity = STUB_IDENTITY;
  readonly calls: Array<{ draft: EvidenceDraft; meta: AgentIdentity }> = [];
  private readonly queuedReceipts: unknown[];

  constructor(queuedReceipts: unknown[] = []) {
    this.queuedReceipts = [...queuedReceipts];
  }

  async listMarkets(): Promise<Market[]> {
    return [];
  }

  async getMarket(): Promise<Market> {
    throw new Error("getMarket is not part of the submitter fake.");
  }

  async health(): Promise<{ status: string }> {
    return { status: "ok" };
  }

  async submitEvidence(
    draft: EvidenceDraft,
    meta: AgentIdentity,
  ): Promise<unknown> {
    this.calls.push({ draft, meta });
    const next = this.queuedReceipts.shift();
    if (next !== undefined) {
      return next;
    }
    return {
      draftId: draft.id,
      marketId: draft.marketId,
      rationale: "Fake receipt: accepted.",
      submissionId: `fake-submission-${this.calls.length}`,
      submittedAt: "2026-11-20T16:00:00.000Z",
      verdict: "accepted",
    };
  }
}

/** An adapter whose first `submitEvidence` throws, then behaves normally. */
class FailOnceAdapter extends RecordingDelphiAdapter {
  private failed = false;

  override async submitEvidence(
    draft: EvidenceDraft,
    meta: AgentIdentity,
  ): Promise<unknown> {
    if (!this.failed) {
      this.failed = true;
      throw new Error("Delphi down");
    }
    return super.submitEvidence(draft, meta);
  }
}

function makeDeps(
  store: MemoryStore,
  adapter: DelphiAdapter,
  overrides: Partial<SubmitDraftDeps> = {},
): SubmitDraftDeps {
  return {
    adapter,
    cycleId: "cycle-1",
    model: "gemini-3.8-flash",
    now: () => FIXED_NOW,
    store,
    ...overrides,
  };
}

/** Store an approval record for a draft, the way the gate requires. */
async function approveInStore(
  store: MemoryStore,
  draftId: string,
): Promise<void> {
  await store.saveApproval({
    approvedAt: "2026-11-20T15:30:00.000Z",
    approvedBy: "human",
    draftId,
  });
}

const VALID_RECEIPT = {
  draftId: "draft-1",
  marketId: "0x0000000000000000000000000000000000000001",
  rationale: "Evidence moved the forecaster.",
  reward: { currency: "USDC", judgment: 0.42 },
  submissionId: "sub-1",
  submittedAt: "2026-11-20T16:00:00.000Z",
  verdict: "accepted",
};

describe("parseSubmissionReceipt", () => {
  it("parses a valid receipt with a judgment reward", () => {
    const receipt = parseSubmissionReceipt(VALID_RECEIPT);

    expect(receipt).toEqual({
      draftId: "draft-1",
      marketId: "0x0000000000000000000000000000000000000001",
      rationale: "Evidence moved the forecaster.",
      reward: { currency: "USDC", judgment: 0.42 },
      submissionId: "sub-1",
      submittedAt: "2026-11-20T16:00:00.000Z",
      verdict: "accepted",
    });
  });

  it("parses a receipt without rationale or reward", () => {
    const minimal = {
      draftId: VALID_RECEIPT.draftId,
      marketId: VALID_RECEIPT.marketId,
      submissionId: VALID_RECEIPT.submissionId,
      submittedAt: VALID_RECEIPT.submittedAt,
      verdict: VALID_RECEIPT.verdict,
    };

    const receipt = parseSubmissionReceipt(minimal);

    expect(receipt.verdict).toBe("accepted");
    expect(receipt.rationale).toBeUndefined();
    expect(receipt.reward).toBeUndefined();
  });

  it("accepts every verdict in the union", () => {
    for (const verdict of ["accepted", "rejected", "judged"]) {
      expect(
        parseSubmissionReceipt({ ...VALID_RECEIPT, verdict }).verdict,
      ).toBe(verdict);
    }
  });

  it("rejects a missing submission id", () => {
    const withoutId = {
      draftId: VALID_RECEIPT.draftId,
      marketId: VALID_RECEIPT.marketId,
      rationale: VALID_RECEIPT.rationale,
      reward: VALID_RECEIPT.reward,
      submittedAt: VALID_RECEIPT.submittedAt,
      verdict: VALID_RECEIPT.verdict,
    };

    expect(() => parseSubmissionReceipt(withoutId)).toThrow(
      ReceiptParseError,
    );
    expect(() => parseSubmissionReceipt(withoutId)).toThrow(/submissionId/);
  });

  it("rejects an unknown verdict", () => {
    expect(() =>
      parseSubmissionReceipt({ ...VALID_RECEIPT, verdict: "pending" }),
    ).toThrow(ReceiptParseError);
  });

  it("tolerates an unknown top-level field: the API returns extra keys", () => {
    // The SDK says extra keys stay readable on submissions, so the
    // parser ignores fields it does not know instead of rejecting
    // the whole receipt. Missing or malformed required fields still
    // fail loudly (see the other tests in this block).
    const receipt = parseSubmissionReceipt({ ...VALID_RECEIPT, bonus: 5 });

    expect(receipt.submissionId).toBe("sub-1");
    expect(receipt.verdict).toBe("accepted");
  });

  it("rejects a reward in the wrong currency", () => {
    expect(() =>
      parseSubmissionReceipt({
        ...VALID_RECEIPT,
        reward: { currency: "ETH", judgment: 1 },
      }),
    ).toThrow(ReceiptParseError);
  });

  it("accepts a reward in USDC.e, the currency rewards are paid in", () => {
    const receipt = parseSubmissionReceipt({
      ...VALID_RECEIPT,
      reward: { currency: "USDC.e", judgment: 0.42 },
    });

    expect(receipt.reward).toEqual({ currency: "USDC.e", judgment: 0.42 });
  });

  it("rejects a negative reward amount", () => {
    expect(() =>
      parseSubmissionReceipt({
        ...VALID_RECEIPT,
        reward: { currency: "USDC", judgment: -0.5 },
      }),
    ).toThrow(ReceiptParseError);
  });

  it("rejects a reward with an unknown field", () => {
    expect(() =>
      parseSubmissionReceipt({
        ...VALID_RECEIPT,
        reward: { currency: "USDC", judgment: 1, tip: 2 },
      }),
    ).toThrow(ReceiptParseError);
  });

  it("rejects a non-object receipt", () => {
    for (const bad of [null, "accepted", 42, ["accepted"]]) {
      expect(() => parseSubmissionReceipt(bad)).toThrow(ReceiptParseError);
    }
  });

  it("rejects a malformed submittedAt timestamp", () => {
    expect(() =>
      parseSubmissionReceipt({ ...VALID_RECEIPT, submittedAt: "soon" }),
    ).toThrow(ReceiptParseError);
  });
});

describe("parseSubmissionReceipt with the real Delphi Submission shape", () => {
  const MARKET_ID = "0x0000000000000000000000000000000000000001";
  const CONTEXT = { draftId: "draft-1", marketId: MARKET_ID };

  /** One submission in the shape the evidence API returns (SDK). */
  function submission(overrides: Record<string, unknown> = {}) {
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
          marketAddress: MARKET_ID,
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

  it("maps a queued submission to an accepted receipt", () => {
    const receipt = parseSubmissionReceipt(submission(), CONTEXT);

    expect(receipt).toEqual({
      draftId: "draft-1",
      marketId: MARKET_ID,
      submissionId: "sub-live-1",
      submittedAt: "2026-11-24T00:05:00.000Z",
      verdict: "accepted",
    });
  });

  it("maps a judging submission to an accepted receipt", () => {
    const receipt = parseSubmissionReceipt(
      submission({ status: "judging" }),
      CONTEXT,
    );

    expect(receipt.verdict).toBe("accepted");
  });

  it("maps a judged submission with a held bounty to a reward", () => {
    const receipt = parseSubmissionReceipt(
      submission({
        market: {
          bounty: { amount: "420000", state: "held" },
          status: "judged",
          verdict: "accepted",
        },
        status: "judged",
      }),
      CONTEXT,
    );

    expect(receipt.verdict).toBe("judged");
    expect(receipt.reward).toEqual({ currency: "USDC.e", judgment: 0.42 });
  });

  it("maps a judged submission with a paid bounty to a reward", () => {
    const receipt = parseSubmissionReceipt(
      submission({
        market: {
          bounty: { amount: "1500000", state: "paid" },
          status: "judged",
        },
        status: "judged",
      }),
      CONTEXT,
    );

    expect(receipt.reward).toEqual({ currency: "USDC.e", judgment: 1.5 });
  });

  it("records no reward for a voided or absent bounty", () => {
    for (const bounty of [
      null,
      { amount: "420000", state: "voided" },
      { amount: "0", state: "none" },
    ]) {
      const receipt = parseSubmissionReceipt(
        submission({ market: { bounty }, status: "judged" }),
        CONTEXT,
      );
      expect(receipt.verdict).toBe("judged");
      expect(receipt.reward).toBeUndefined();
    }
  });

  it("explains a zero payment through the zero-pay reason", () => {
    const receipt = parseSubmissionReceipt(
      submission({
        market: {
          bounty: { amount: "0", state: "none" },
          zeroPayReason: "below_minimum",
        },
        status: "judged",
      }),
      CONTEXT,
    );

    expect(receipt.reward).toBeUndefined();
    expect(receipt.rationale).toMatch(/below_minimum/);
  });

  it("maps rejected, failed, and unmatched submissions to rejected", () => {
    for (const status of ["rejected", "failed", "unmatched"]) {
      const receipt = parseSubmissionReceipt(
        submission({
          market: { reason: "Evidence does not move the forecaster." },
          status,
        }),
        CONTEXT,
      );
      expect(receipt.verdict).toBe("rejected");
      expect(receipt.rationale).toBe(
        "Evidence does not move the forecaster.",
      );
    }
  });

  it("falls back to the submission code when no market reason exists", () => {
    const receipt = parseSubmissionReceipt(
      submission({ code: "duplicate_submission", status: "rejected" }),
      CONTEXT,
    );

    expect(receipt.rationale).toBe("duplicate_submission");
  });

  it("tolerates the extra fields the API returns", () => {
    const receipt = parseSubmissionReceipt(
      submission({
        canRetry: true,
        judgingEstimateSeconds: 120,
        retryAt: "2026-11-24T00:10:00.000Z",
        someFutureField: { nested: true },
      }),
      CONTEXT,
    );

    expect(receipt.verdict).toBe("accepted");
    expect(receipt.submissionId).toBe("sub-live-1");
  });

  it("matches the market address case-insensitively", () => {
    const receipt = parseSubmissionReceipt(
      submission({
        market: { marketAddress: MARKET_ID.toUpperCase() },
      }),
      CONTEXT,
    );

    expect(receipt.marketId).toBe(MARKET_ID);
  });

  it("fails without draft and market context for a real submission", () => {
    expect(() => parseSubmissionReceipt(submission())).toThrow(
      ReceiptParseError,
    );
    expect(() => parseSubmissionReceipt(submission())).toThrow(/context/i);
  });

  it("fails when no market entry matches the submitted market", () => {
    expect(() =>
      parseSubmissionReceipt(
        submission({
          market: {
            marketAddress: "0x0000000000000000000000000000000000000002",
          },
        }),
        CONTEXT,
      ),
    ).toThrow(ReceiptParseError);
    expect(() =>
      parseSubmissionReceipt(
        submission({
          market: {
            marketAddress: "0x0000000000000000000000000000000000000002",
          },
        }),
        CONTEXT,
      ),
    ).toThrow(new RegExp(MARKET_ID));
  });

  it("fails on a missing id, timestamp, status, or markets list", () => {
    for (const bad of [
      submission({ id: undefined }),
      submission({ createdAt: undefined }),
      submission({ createdAt: "soon" }),
      submission({ status: undefined }),
      submission({ markets: undefined }),
      submission({ markets: [] }),
    ]) {
      expect(() => parseSubmissionReceipt(bad, CONTEXT)).toThrow(
        ReceiptParseError,
      );
    }
  });

  it("fails on an unknown submission status", () => {
    expect(() =>
      parseSubmissionReceipt(submission({ status: "mystery" }), CONTEXT),
    ).toThrow(ReceiptParseError);
  });

  it("fails on a bounty amount that is not base units", () => {
    expect(() =>
      parseSubmissionReceipt(
        submission({
          market: { bounty: { amount: "lots", state: "held" } },
          status: "judged",
        }),
        CONTEXT,
      ),
    ).toThrow(ReceiptParseError);
    expect(() =>
      parseSubmissionReceipt(
        submission({
          market: { bounty: { amount: "-5", state: "held" } },
          status: "judged",
        }),
        CONTEXT,
      ),
    ).toThrow(ReceiptParseError);
  });
});

describe("submitDraft happy path", () => {
  it("sends an approved draft through the adapter and returns the receipt", async () => {
    const store = await makeStore();
    const adapter = new RecordingDelphiAdapter();
    const draft = makeDraft();
    await store.saveDraft(draft);
    await approveInStore(store, draft.id);

    const result = await submitDraft(draft, makeDeps(store, adapter));

    expect(adapter.calls).toHaveLength(1);
    expect(adapter.calls[0]!.draft).toEqual(draft);
    expect(result.receipt.verdict).toBe("accepted");
    expect(result.receipt.draftId).toBe("draft-1");
    expect(result.receipt.marketId).toBe(MARKET_A);
    expect(result.submission.id).toBe(result.receipt.submissionId);
    expect(result.submission.cycleId).toBe("cycle-1");
    expect(result.submission.status).toBe("accepted");
  });

  it("sends the agent name, harness, and drafting model with the request", async () => {
    const store = await makeStore();
    const adapter = new RecordingDelphiAdapter();
    const draft = makeDraft();
    await store.saveDraft(draft);
    await approveInStore(store, draft.id);

    await submitDraft(draft, makeDeps(store, adapter));

    expect(adapter.calls[0]!.meta).toEqual({
      agentName: "Vgen19",
      harness: "vgen19",
      model: "gemini-3.8-flash",
    });
  });

  it("records the submission and marks the draft submitted", async () => {
    const store = await makeStore();
    const adapter = new RecordingDelphiAdapter();
    const draft = makeDraft();
    await store.saveDraft(draft);
    await approveInStore(store, draft.id);

    const result = await submitDraft(draft, makeDeps(store, adapter));

    const stored = await store.loadSubmission(result.submission.id);
    expect(stored).toEqual(result.submission);
    expect(stored!.receipt).toEqual(result.receipt);
    const savedDraft = await store.loadDraft(draft.id);
    expect(savedDraft!.status).toBe("submitted");
  });

  it("records the judgment reward from the receipt against the submission", async () => {
    const store = await makeStore();
    const adapter = new RecordingDelphiAdapter([
      {
        draftId: "draft-1",
        marketId: MARKET_A,
        rationale: "Evidence moved the forecaster.",
        reward: { currency: "USDC", judgment: 0.42 },
        submissionId: "sub-1",
        submittedAt: "2026-11-20T16:00:00.000Z",
        verdict: "judged",
      },
    ]);
    const draft = makeDraft();
    await store.saveDraft(draft);
    await approveInStore(store, draft.id);

    const result = await submitDraft(draft, makeDeps(store, adapter));

    expect(result.receipt.verdict).toBe("judged");
    const reward = await store.loadReward("sub-1");
    expect(reward).toEqual({
      currency: "USDC",
      draftId: "draft-1",
      judgment: 0.42,
      marketId: MARKET_A,
      recordedAt: "2026-11-20T16:00:00.000Z",
      submissionId: "sub-1",
    });
    // A judged submission was accepted: the draft is submitted.
    expect((await store.loadDraft(draft.id))!.status).toBe("submitted");
  });

  it("records no reward when the receipt carries none", async () => {
    const store = await makeStore();
    const adapter = new RecordingDelphiAdapter();
    const draft = makeDraft();
    await store.saveDraft(draft);
    await approveInStore(store, draft.id);

    const result = await submitDraft(draft, makeDeps(store, adapter));

    expect(await store.loadReward(result.submission.id)).toBeUndefined();
    expect(await store.loadRewards()).toEqual([]);
  });

  it("records the reward in the currency the receipt carried (USDC.e)", async () => {
    const store = await makeStore();
    const adapter = new RecordingDelphiAdapter([
      {
        draftId: "draft-1",
        marketId: MARKET_A,
        reward: { currency: "USDC.e", judgment: 0.42 },
        submissionId: "sub-1",
        submittedAt: "2026-11-20T16:00:00.000Z",
        verdict: "judged",
      },
    ]);
    const draft = makeDraft();
    await store.saveDraft(draft);
    await approveInStore(store, draft.id);

    await submitDraft(draft, makeDeps(store, adapter));

    const reward = await store.loadReward("sub-1");
    expect(reward!.currency).toBe("USDC.e");
    expect(reward!.judgment).toBe(0.42);
  });
});

describe("submitDraft refusals", () => {
  it("refuses a draft whose status is not approved, naming the status", async () => {
    const store = await makeStore();
    const adapter = new RecordingDelphiAdapter();
    for (const status of ["draft", "rejected", "submitted"] as const) {
      const draft = makeDraft({ id: `draft-${status}`, status });
      await store.saveDraft(draft);
      await approveInStore(store, draft.id);

      const error = await submitDraft(draft, makeDeps(store, adapter)).catch(
        (caught: unknown) => caught,
      );

      expect(error).toBeInstanceOf(SubmissionRefusedError);
      expect((error as SubmissionRefusedError).reason).toBe("not-approved");
      expect((error as Error).message).toContain(`status is "${status}"`);
    }
    expect(adapter.calls).toHaveLength(0);
    const refusals = await store.loadRefusals();
    expect(refusals).toHaveLength(3);
    expect(refusals.every((r) => r.reason === "not-approved")).toBe(true);
    expect(await store.loadSubmissions()).toEqual([]);
  });

  it("refuses when the gate is on and no approval exists, and sends nothing", async () => {
    const store = await makeStore();
    const adapter = new RecordingDelphiAdapter();
    const draft = makeDraft();
    await store.saveDraft(draft);

    const error = await submitDraft(draft, makeDeps(store, adapter)).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(SubmissionRefusedError);
    expect((error as SubmissionRefusedError).reason).toBe("gate");
    expect((error as Error).message).toContain("approval gate is on");
    expect(adapter.calls).toHaveLength(0);
    const refusals = await store.loadRefusals();
    expect(refusals).toHaveLength(1);
    expect(refusals[0]!.reason).toBe("gate");
    expect(await store.loadSubmissions()).toEqual([]);
  });

  it("sends when the gate is on and an approval exists", async () => {
    const store = await makeStore();
    const adapter = new RecordingDelphiAdapter();
    const draft = makeDraft();
    await store.saveDraft(draft);
    await approveInStore(store, draft.id);

    await submitDraft(draft, makeDeps(store, adapter, { approvalGate: true }));

    expect(adapter.calls).toHaveLength(1);
  });

  it("sends without approval when the gate is off, with a warning", async () => {
    const store = await makeStore();
    const adapter = new RecordingDelphiAdapter();
    const draft = makeDraft();
    await store.saveDraft(draft);
    const warnings: string[] = [];

    await submitDraft(
      draft,
      makeDeps(store, adapter, {
        approvalGate: false,
        warn: (message: string) => warnings.push(message),
      }),
    );

    expect(adapter.calls).toHaveLength(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("approval gate is OFF");
  });

  it("fails closed: the gate defaults to on", async () => {
    const store = await makeStore();
    const adapter = new RecordingDelphiAdapter();
    const draft = makeDraft();
    await store.saveDraft(draft);

    await expect(
      submitDraft(draft, makeDeps(store, adapter)),
    ).rejects.toThrow(SubmissionRefusedError);
    expect(adapter.calls).toHaveLength(0);
  });

  it("enforces the per-market cap: the 3rd submission is ok, the 4th is refused", async () => {
    const store = await makeStore();
    const adapter = new RecordingDelphiAdapter();
    for (let n = 1; n <= 3; n += 1) {
      const draft = makeDraft({ id: `draft-${n}` });
      await store.saveDraft(draft);
      await approveInStore(store, draft.id);
      await submitDraft(
        draft,
        makeDeps(store, adapter, { cycleId: `cycle-${n}` }),
      );
    }

    const fourth = makeDraft({ id: "draft-4" });
    await store.saveDraft(fourth);
    await approveInStore(store, fourth.id);
    const error = await submitDraft(
      fourth,
      makeDeps(store, adapter, { cycleId: "cycle-4" }),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SubmissionRefusedError);
    expect((error as SubmissionRefusedError).reason).toBe("cap-market");
    expect((error as Error).message).toContain("3 submissions");
    expect(adapter.calls).toHaveLength(3);
    expect(await store.loadSubmissions({ marketId: MARKET_A })).toHaveLength(
      3,
    );
    const refusals = await store.loadRefusals();
    expect(refusals).toHaveLength(1);
    expect(refusals[0]!.reason).toBe("cap-market");
    expect(refusals[0]!.draftId).toBe("draft-4");
  });

  it("enforces the per-cycle cap with the configured limit", async () => {
    const store = await makeStore();
    const adapter = new RecordingDelphiAdapter();
    const otherMarket = "0x0000000000000000000000000000000000000002";
    for (let n = 1; n <= 2; n += 1) {
      const draft = makeDraft({
        id: `draft-${n}`,
        marketId: n === 1 ? MARKET_A : otherMarket,
      });
      await store.saveDraft(draft);
      await approveInStore(store, draft.id);
      await submitDraft(
        draft,
        makeDeps(store, adapter, { maxSubmissionsPerCycle: 2 }),
      );
    }

    const third = makeDraft({ id: "draft-3", marketId: otherMarket });
    await store.saveDraft(third);
    await approveInStore(store, third.id);
    const error = await submitDraft(
      third,
      makeDeps(store, adapter, { maxSubmissionsPerCycle: 2 }),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SubmissionRefusedError);
    expect((error as SubmissionRefusedError).reason).toBe("cap-cycle");
    expect((error as Error).message).toContain("cycle-1");
    expect(adapter.calls).toHaveLength(2);
    expect(await store.loadSubmissions({ cycleId: "cycle-1" })).toHaveLength(
      2,
    );
  });

  it("defaults the per-cycle cap to 5", async () => {
    const store = await makeStore();
    const adapter = new RecordingDelphiAdapter();
    for (let n = 1; n <= 5; n += 1) {
      const draft = makeDraft({
        id: `draft-${n}`,
        marketId: `0x000000000000000000000000000000000000000${n}`,
      });
      await store.saveDraft(draft);
      await approveInStore(store, draft.id);
      await submitDraft(draft, makeDeps(store, adapter));
    }

    const sixth = makeDraft({
      id: "draft-6",
      marketId: "0x0000000000000000000000000000000000000006",
    });
    await store.saveDraft(sixth);
    await approveInStore(store, sixth.id);

    await expect(submitDraft(sixth, makeDeps(store, adapter))).rejects.toThrow(
      SubmissionRefusedError,
    );
    expect(adapter.calls).toHaveLength(5);
  });

  it("refuses a malformed draft before anything is sent", async () => {
    const store = await makeStore();
    const adapter = new RecordingDelphiAdapter();
    const draft = makeDraft({ links: [] });
    await approveInStore(store, draft.id);

    await expect(submitDraft(draft, makeDeps(store, adapter))).rejects.toThrow(
      /at least 1 link/,
    );
    expect(adapter.calls).toHaveLength(0);
  });
});

describe("submitDraft receipts", () => {
  it("records a rejected receipt and leaves the draft approved for a retry", async () => {
    const store = await makeStore();
    const adapter = new RecordingDelphiAdapter([
      {
        draftId: "draft-1",
        marketId: MARKET_A,
        rationale: "Evidence already covered by an earlier submission.",
        submissionId: "sub-1",
        submittedAt: "2026-11-20T16:00:00.000Z",
        verdict: "rejected",
      },
    ]);
    const draft = makeDraft();
    await store.saveDraft(draft);
    await approveInStore(store, draft.id);

    const result = await submitDraft(draft, makeDeps(store, adapter));

    expect(result.receipt.verdict).toBe("rejected");
    expect(result.submission.status).toBe("rejected");
    expect(result.submission.receipt.rationale).toBe(
      "Evidence already covered by an earlier submission.",
    );
    const stored = await store.loadSubmission("sub-1");
    expect(stored).toEqual(result.submission);
    // The draft stays approved: it may be retried in a later cycle.
    expect((await store.loadDraft(draft.id))!.status).toBe("approved");
    expect(await store.loadRewards()).toEqual([]);
  });

  it("rejects a malformed receipt and records nothing", async () => {
    const store = await makeStore();
    const adapter = new RecordingDelphiAdapter([
      { draftId: "draft-1", verdict: "maybe" },
    ]);
    const draft = makeDraft();
    await store.saveDraft(draft);
    await approveInStore(store, draft.id);

    await expect(submitDraft(draft, makeDeps(store, adapter))).rejects.toThrow(
      ReceiptParseError,
    );
    expect(await store.loadSubmissions()).toEqual([]);
    expect((await store.loadDraft(draft.id))!.status).toBe("approved");
  });

  it("rejects a receipt that names a different draft or market", async () => {
    const store = await makeStore();
    const adapter = new RecordingDelphiAdapter([
      {
        draftId: "draft-someone-else",
        marketId: MARKET_A,
        submissionId: "sub-1",
        submittedAt: "2026-11-20T16:00:00.000Z",
        verdict: "accepted",
      },
    ]);
    const draft = makeDraft();
    await store.saveDraft(draft);
    await approveInStore(store, draft.id);

    await expect(submitDraft(draft, makeDeps(store, adapter))).rejects.toThrow(
      ReceiptParseError,
    );
    expect(await store.loadSubmissions()).toEqual([]);
  });
});

describe("submitDraft crash recovery", () => {
  it("never resubmits after a crash between the adapter call and the memory write", async () => {
    const store = new CrashOnceStore(await makeTempDir());
    const adapter = new RecordingDelphiAdapter();
    const draft = makeDraft();
    await store.saveDraft(draft);
    await approveInStore(store, draft.id);

    // The adapter recorded the submission, then the memory write
    // failed: Delphi has the evidence, memory has no submission.
    await expect(
      submitDraft(draft, makeDeps(store, adapter)),
    ).rejects.toThrow(/simulated crash/);
    expect(adapter.calls).toHaveLength(1);
    expect(await store.loadSubmissions()).toEqual([]);
    expect(await store.loadPendingSubmission(draft.id)).toBeDefined();

    // A resume refuses without calling the adapter again: the
    // evidence may already be at Delphi, so sending it twice would
    // be a duplicate submission.
    const error = await submitDraft(draft, makeDeps(store, adapter)).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(SubmissionRefusedError);
    expect((error as SubmissionRefusedError).reason).toBe("pending");
    expect(adapter.calls).toHaveLength(1);
    expect(await store.loadSubmissions()).toEqual([]);
  });

  it("resolves from the stored submission when the draft was already submitted", async () => {
    const store = await makeStore();
    const adapter = new RecordingDelphiAdapter();
    // Two other submissions already fill the market toward its cap.
    for (let n = 2; n <= 3; n += 1) {
      const other = makeDraft({ id: `draft-${n}` });
      await store.saveDraft(other);
      await approveInStore(store, other.id);
      await submitDraft(
        other,
        makeDeps(store, adapter, { cycleId: `cycle-${n}` }),
      );
    }
    const draft = makeDraft();
    await store.saveDraft(draft);
    await approveInStore(store, draft.id);
    const first = await submitDraft(draft, makeDeps(store, adapter));

    // Simulate the crash window: the submission is recorded but the
    // draft still reads as approved.
    draft.status = "approved";
    await store.saveDraft(draft);

    // The resolve runs before the cap checks: the market is now at
    // its 3-submission cap, but this draft's own submission must
    // resolve, not refuse.
    const second = await submitDraft(draft, makeDeps(store, adapter));

    expect(adapter.calls).toHaveLength(3);
    expect(second.submission).toEqual(first.submission);
    expect(second.receipt).toEqual(first.receipt);
    expect((await store.loadDraft(draft.id))!.status).toBe("submitted");
    expect(await store.loadSubmissions({ marketId: MARKET_A })).toHaveLength(
      3,
    );
  });

  it("clears the pending record when the adapter fails, so a retry can proceed", async () => {
    const store = await makeStore();
    const adapter = new FailOnceAdapter();
    const draft = makeDraft();
    await store.saveDraft(draft);
    await approveInStore(store, draft.id);

    await expect(
      submitDraft(draft, makeDeps(store, adapter)),
    ).rejects.toThrow(/Delphi down/);
    expect(adapter.calls).toHaveLength(0);
    expect(await store.loadPendingSubmission(draft.id)).toBeUndefined();

    const result = await submitDraft(draft, makeDeps(store, adapter));

    expect(adapter.calls).toHaveLength(1);
    expect(result.submission.status).toBe("accepted");
    expect(await store.loadPendingSubmission(draft.id)).toBeUndefined();
  });

  it("leaves no pending record behind after a successful submission", async () => {
    const store = await makeStore();
    const adapter = new RecordingDelphiAdapter();
    const draft = makeDraft();
    await store.saveDraft(draft);
    await approveInStore(store, draft.id);

    await submitDraft(draft, makeDeps(store, adapter));

    expect(await store.loadPendingSubmission(draft.id)).toBeUndefined();
  });
});

describe("submitDraft known facts", () => {
  async function storeNotesWithFindings(store: MemoryStore): Promise<void> {
    await store.saveResearchNotes({
      compacted: false,
      failedSources: [],
      fetchedAt: "2026-11-20T15:00:00.000Z",
      findings: [
        {
          claim: "Zanara set its general election for 15 December 2026.",
          date: "2026-12-15",
          sourceUrl: "https://example.com/zanara",
        },
        {
          claim: "An uncited finding from another source.",
          date: "2026-12-15",
          sourceUrl: "https://example.com/other",
        },
      ],
      marketId: MARKET_A,
      question: "Will Zanara hold a general election before 31 December 2026?",
    });
  }

  it("records the submitted draft's cited facts as known facts", async () => {
    const store = await makeStore();
    const adapter = new RecordingDelphiAdapter();
    const draft = makeDraft();
    await store.saveDraft(draft);
    await approveInStore(store, draft.id);
    await storeNotesWithFindings(store);

    await submitDraft(draft, makeDeps(store, adapter));

    // Only the finding the draft actually cited is recorded; the
    // uncited finding stays available for a later draft.
    const known = await store.loadKnownFacts(MARKET_A);
    expect(known).toHaveLength(1);
    expect(known[0]!.claim).toBe(
      "Zanara set its general election for 15 December 2026.",
    );
    expect(known[0]!.sourceUrl).toBe("https://example.com/zanara");
    expect(known[0]!.normalizedClaim).toBe(
      "zanara set its general election for 15 december 2026.",
    );
  });

  it("records known facts even when Delphi rejects the submission", async () => {
    const store = await makeStore();
    const adapter = new RecordingDelphiAdapter([
      {
        draftId: "draft-1",
        marketId: MARKET_A,
        rationale: "Evidence already covered.",
        submissionId: "sub-1",
        submittedAt: "2026-11-20T16:00:00.000Z",
        verdict: "rejected",
      },
    ]);
    const draft = makeDraft();
    await store.saveDraft(draft);
    await approveInStore(store, draft.id);
    await storeNotesWithFindings(store);

    await submitDraft(draft, makeDeps(store, adapter));

    // The facts reached Delphi even though the verdict was a
    // rejection, so they are known.
    expect(await store.loadKnownFacts(MARKET_A)).toHaveLength(1);
  });

  it("records nothing when the market has no stored research notes", async () => {
    const store = await makeStore();
    const adapter = new RecordingDelphiAdapter();
    const draft = makeDraft();
    await store.saveDraft(draft);
    await approveInStore(store, draft.id);

    await submitDraft(draft, makeDeps(store, adapter));

    expect(await store.loadKnownFacts(MARKET_A)).toEqual([]);
  });
});

describe("submitDraft evidence cutoff", () => {
  it("refuses a market whose evidence cutoff has passed, sending nothing", async () => {
    const store = await makeStore();
    const adapter = new RecordingDelphiAdapter();
    const pastCutoff = {
      ...structuredClone(fixtureMarkets[0]!),
      competition: {
        ...fixtureMarkets[0]!.competition,
        evidenceCutoff: "2026-11-01T00:00:00.000Z",
      },
    };
    await store.saveMarkets([pastCutoff]);
    const draft = makeDraft();
    await store.saveDraft(draft);
    await approveInStore(store, draft.id);

    const error = await submitDraft(draft, makeDeps(store, adapter)).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(SubmissionRefusedError);
    expect((error as SubmissionRefusedError).reason).toBe("past-cutoff");
    expect((error as Error).message).toContain("evidence cutoff");
    expect(adapter.calls).toHaveLength(0);
    expect(await store.loadSubmissions()).toEqual([]);
  });

  it("sends when the market's cutoff is still in the future", async () => {
    const store = await makeStore();
    const adapter = new RecordingDelphiAdapter();
    await store.saveMarkets([structuredClone(fixtureMarkets[0]!)]);
    const draft = makeDraft();
    await store.saveDraft(draft);
    await approveInStore(store, draft.id);

    await submitDraft(draft, makeDeps(store, adapter));

    expect(adapter.calls).toHaveLength(1);
  });
});

describe("createDraftSubmitter (draft pipeline seam)", () => {
  it("resolves for an accepted receipt so the pipeline can mark the draft submitted", async () => {
    const store = await makeStore();
    const adapter = new RecordingDelphiAdapter();
    const draft = makeDraft();
    await store.saveDraft(draft);
    await approveInStore(store, draft.id);
    const submit = createDraftSubmitter(makeDeps(store, adapter));

    await expect(submit(draft)).resolves.toBeUndefined();
    expect((await store.loadDraft(draft.id))!.status).toBe("submitted");
  });

  it("throws SubmissionRejectedError on a rejected receipt, carrying the receipt", async () => {
    const store = await makeStore();
    const adapter = new RecordingDelphiAdapter([
      {
        draftId: "draft-1",
        marketId: MARKET_A,
        rationale: "Duplicate evidence.",
        submissionId: "sub-1",
        submittedAt: "2026-11-20T16:00:00.000Z",
        verdict: "rejected",
      },
    ]);
    const draft = makeDraft();
    await store.saveDraft(draft);
    await approveInStore(store, draft.id);
    const submit = createDraftSubmitter(makeDeps(store, adapter));

    const error = await submit(draft).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SubmissionRejectedError);
    expect((error as SubmissionRejectedError).receipt.verdict).toBe(
      "rejected",
    );
    expect((error as Error).message).toContain("Duplicate evidence.");
    // The pipeline never marks the draft submitted after a throw.
    expect((await store.loadDraft(draft.id))!.status).toBe("approved");
  });
});

describe("approveDraft", () => {
  it("records a human approval for the draft and returns it", async () => {
    const store = await makeStore();
    const draft = makeDraft();
    await store.saveDraft(draft);

    const approval = await approveDraft(store, draft.id, "Looks good.", {
      now: () => FIXED_NOW,
    });

    expect(approval).toEqual({
      approvedAt: "2026-11-20T16:00:00.000Z",
      approvedBy: "human",
      draftId: "draft-1",
      note: "Looks good.",
    });
    expect(await store.loadApproval(draft.id)).toEqual(approval);
  });

  it("records an approval without a note", async () => {
    const store = await makeStore();
    await store.saveDraft(makeDraft());

    const approval = await approveDraft(store, "draft-1", undefined, {
      now: () => FIXED_NOW,
    });

    expect(approval.note).toBeUndefined();
  });

  it("refuses to approve a draft that does not exist", async () => {
    const store = await makeStore();

    await expect(approveDraft(store, "no-such-draft")).rejects.toThrow(
      "Draft not found: no-such-draft",
    );
    expect(await store.loadApproval("no-such-draft")).toBeUndefined();
  });

  it("an approval recorded here opens the gate for submitDraft", async () => {
    const store = await makeStore();
    const adapter = new RecordingDelphiAdapter();
    const draft = makeDraft();
    await store.saveDraft(draft);

    await approveDraft(store, draft.id);
    await submitDraft(draft, makeDeps(store, adapter));

    expect(adapter.calls).toHaveLength(1);
  });
});

describe("recordSettlementReward", () => {
  it("adds a settlement reward to the submission's existing reward record", async () => {
    const store = await makeStore();
    const adapter = new RecordingDelphiAdapter([
      {
        draftId: "draft-1",
        marketId: MARKET_A,
        reward: { currency: "USDC", judgment: 0.42 },
        submissionId: "sub-1",
        submittedAt: "2026-11-20T16:00:00.000Z",
        verdict: "judged",
      },
    ]);
    const draft = makeDraft();
    await store.saveDraft(draft);
    await approveInStore(store, draft.id);
    await submitDraft(draft, makeDeps(store, adapter));

    const updated = await recordSettlementReward(store, "sub-1", 1.1, {
      now: () => new Date("2026-11-21T16:00:00.000Z"),
    });

    expect(updated).toEqual({
      currency: "USDC",
      draftId: "draft-1",
      judgment: 0.42,
      marketId: MARKET_A,
      recordedAt: "2026-11-21T16:00:00.000Z",
      settlement: 1.1,
      submissionId: "sub-1",
    });
    expect(await store.loadReward("sub-1")).toEqual(updated);
    expect(await store.loadRewards()).toHaveLength(1);
  });

  it("creates a reward record when the receipt carried no reward", async () => {
    const store = await makeStore();
    const adapter = new RecordingDelphiAdapter();
    const draft = makeDraft();
    await store.saveDraft(draft);
    await approveInStore(store, draft.id);
    const { submission } = await submitDraft(draft, makeDeps(store, adapter));
    expect(await store.loadReward(submission.id)).toBeUndefined();

    const created = await recordSettlementReward(store, submission.id, 2.5, {
      now: () => FIXED_NOW,
    });

    expect(created.settlement).toBe(2.5);
    expect(created.judgment).toBeUndefined();
    expect(created.draftId).toBe("draft-1");
    expect(created.marketId).toBe(MARKET_A);
  });

  it("preserves the existing record's currency when adding a settlement reward", async () => {
    const store = await makeStore();
    const adapter = new RecordingDelphiAdapter([
      {
        draftId: "draft-1",
        marketId: MARKET_A,
        reward: { currency: "USDC.e", judgment: 0.42 },
        submissionId: "sub-1",
        submittedAt: "2026-11-20T16:00:00.000Z",
        verdict: "judged",
      },
    ]);
    const draft = makeDraft();
    await store.saveDraft(draft);
    await approveInStore(store, draft.id);
    await submitDraft(draft, makeDeps(store, adapter));
    expect((await store.loadReward("sub-1"))!.currency).toBe("USDC.e");

    const updated = await recordSettlementReward(store, "sub-1", 1.1, {
      now: () => new Date("2026-11-21T16:00:00.000Z"),
    });

    expect(updated.currency).toBe("USDC.e");
    expect(updated.judgment).toBe(0.42);
    expect(updated.settlement).toBe(1.1);
  });

  it("refuses a settlement reward for an unknown submission", async () => {
    const store = await makeStore();

    await expect(
      recordSettlementReward(store, "no-such-submission", 1),
    ).rejects.toThrow("Unknown submission: no-such-submission");
    expect(await store.loadRewards()).toEqual([]);
  });

  it("refuses a negative or non-finite settlement amount", async () => {
    const store = await makeStore();
    const adapter = new RecordingDelphiAdapter();
    const draft = makeDraft();
    await store.saveDraft(draft);
    await approveInStore(store, draft.id);
    const { submission } = await submitDraft(draft, makeDeps(store, adapter));

    await expect(
      recordSettlementReward(store, submission.id, -1),
    ).rejects.toThrow(/non-negative/);
    await expect(
      recordSettlementReward(store, submission.id, Number.NaN),
    ).rejects.toThrow(/non-negative/);
    expect(await store.loadRewards()).toEqual([]);
  });
});
