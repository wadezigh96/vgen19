import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { CliOutput } from "../src/cli.js";
import { loadConfig, type Vgen19Config } from "../src/config.js";
import type { DelphiAdapter } from "../src/delphi/adapter.js";
import { STUB_IDENTITY, StubDelphiAdapter } from "../src/delphi/stub.js";
import type { AgentIdentity, Market } from "../src/delphi/types.js";
import {
  approveCommand,
  createApproveCommand,
  createSubmitCommand,
  submitCommand,
} from "../src/commands/submit.js";
import type { EvidenceDraft } from "../src/draft/types.js";
import { MemoryStore } from "../src/memory/store.js";

let tempDirs: string[] = [];

async function makeStore(): Promise<MemoryStore> {
  const dir = await mkdtemp(join(tmpdir(), "vgen19-submit-cmd-test-"));
  tempDirs.push(dir);
  return new MemoryStore(dir);
}

afterEach(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { force: true, recursive: true });
  }
  tempDirs = [];
});

function captureOutput(): { chunks: { err: string; out: string }; output: CliOutput } {
  const chunks = { err: "", out: "" };
  const output: CliOutput = {
    writeErr(text: string) {
      chunks.err += text;
    },
    writeOut(text: string) {
      chunks.out += text;
    },
  };
  return { chunks, output };
}

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

function makeConfig(env: Record<string, string> = {}): Vgen19Config {
  return loadConfig(env);
}

/** Fake Delphi API for command tests: answers with one queued receipt. */
class FakeDelphiAdapter implements DelphiAdapter {
  readonly identity: AgentIdentity = STUB_IDENTITY;
  readonly calls: Array<{ draft: EvidenceDraft; meta: AgentIdentity }> = [];
  private readonly receipt: unknown;

  constructor(receipt: unknown) {
    this.receipt = receipt;
  }

  async listMarkets(): Promise<Market[]> {
    return [];
  }

  async getMarket(): Promise<Market> {
    throw new Error("getMarket is not part of the command fake.");
  }

  async health(): Promise<{ status: string }> {
    return { status: "ok" };
  }

  async submitEvidence(
    draft: EvidenceDraft,
    meta: AgentIdentity,
  ): Promise<unknown> {
    this.calls.push({ draft, meta });
    return this.receipt;
  }
}

describe("submit command", () => {
  it("submits an approved draft and prints the receipt, exiting 0", async () => {
    const store = await makeStore();
    const draft = makeDraft();
    await store.saveDraft(draft);
    await store.saveApproval({
      approvedAt: "2026-11-20T15:30:00.000Z",
      approvedBy: "human",
      draftId: draft.id,
    });
    const { chunks, output } = captureOutput();
    const command = createSubmitCommand({
      adapter: new StubDelphiAdapter(),
      config: makeConfig(),
      now: () => FIXED_NOW,
      store,
    });

    const exitCode = await command.run(["draft-1", "--cycle", "cycle-9"], output);

    expect(exitCode).toBe(0);
    expect(chunks.out).toContain("draft-1");
    expect(chunks.out).toContain("cycle-9");
    expect(chunks.out).toContain("ACCEPTED");
    expect(chunks.out).toContain("Stub receipt");
    expect(chunks.out).toContain("SUBMITTED");
    expect(chunks.err).toBe("");
    expect((await store.loadDraft("draft-1"))!.status).toBe("submitted");
  });

  it("finds the draft id when --cycle comes first", async () => {
    const store = await makeStore();
    const draft = makeDraft();
    await store.saveDraft(draft);
    await store.saveApproval({
      approvedAt: "2026-11-20T15:30:00.000Z",
      approvedBy: "human",
      draftId: draft.id,
    });
    const { chunks, output } = captureOutput();
    const command = createSubmitCommand({
      adapter: new StubDelphiAdapter(),
      config: makeConfig(),
      now: () => FIXED_NOW,
      store,
    });

    // The flag value ("cycle-9") must not be mistaken for the draft id.
    const exitCode = await command.run(["--cycle", "cycle-9", "draft-1"], output);

    expect(exitCode).toBe(0);
    expect(chunks.out).toContain("draft-1");
    expect(chunks.out).toContain("cycle-9");
    expect((await store.loadDraft("draft-1"))!.status).toBe("submitted");
  });

  it("rejects a cycle id that would escape the data dir", async () => {
    const store = await makeStore();
    const draft = makeDraft();
    await store.saveDraft(draft);
    await store.saveApproval({
      approvedAt: "2026-11-20T15:30:00.000Z",
      approvedBy: "human",
      draftId: draft.id,
    });
    const { chunks, output } = captureOutput();
    const command = createSubmitCommand({
      adapter: new StubDelphiAdapter(),
      config: makeConfig(),
      now: () => FIXED_NOW,
      store,
    });

    const exitCode = await command.run(["draft-1", "--cycle", "../../x"], output);

    expect(exitCode).toBe(1);
    expect(chunks.err).toMatch(/cycle id/i);
    expect(await store.loadSubmissions()).toEqual([]);
  });

  it("defaults the cycle id to a manual timestamp id", async () => {
    const store = await makeStore();
    const draft = makeDraft();
    await store.saveDraft(draft);
    await store.saveApproval({
      approvedAt: "2026-11-20T15:30:00.000Z",
      approvedBy: "human",
      draftId: draft.id,
    });
    const { chunks, output } = captureOutput();
    const command = createSubmitCommand({
      adapter: new StubDelphiAdapter(),
      config: makeConfig(),
      now: () => FIXED_NOW,
      store,
    });

    const exitCode = await command.run(["draft-1"], output);

    expect(exitCode).toBe(0);
    expect(chunks.out).toContain("manual-2026-11-20T16:00:00.000Z");
    const submissions = await store.loadSubmissions();
    expect(submissions[0]!.cycleId).toBe("manual-2026-11-20T16:00:00.000Z");
  });

  it("prints the reward from the receipt", async () => {
    const store = await makeStore();
    const draft = makeDraft();
    await store.saveDraft(draft);
    await store.saveApproval({
      approvedAt: "2026-11-20T15:30:00.000Z",
      approvedBy: "human",
      draftId: draft.id,
    });
    const adapter = new FakeDelphiAdapter({
      draftId: "draft-1",
      marketId: MARKET_A,
      rationale: "Evidence moved the forecaster.",
      reward: { currency: "USDC", judgment: 0.42 },
      submissionId: "sub-1",
      submittedAt: "2026-11-20T16:00:00.000Z",
      verdict: "judged",
    });
    const { chunks, output } = captureOutput();
    const command = createSubmitCommand({
      adapter,
      config: makeConfig(),
      now: () => FIXED_NOW,
      store,
    });

    const exitCode = await command.run(["draft-1"], output);

    expect(exitCode).toBe(0);
    expect(chunks.out).toContain("JUDGED");
    expect(chunks.out).toContain("0.42 USDC");
  });

  it("exits non-zero with a clear message when the gate refuses", async () => {
    const store = await makeStore();
    await store.saveDraft(makeDraft());
    const { chunks, output } = captureOutput();
    const command = createSubmitCommand({
      adapter: new StubDelphiAdapter(),
      config: makeConfig(),
      now: () => FIXED_NOW,
      store,
    });

    const exitCode = await command.run(["draft-1"], output);

    expect(exitCode).not.toBe(0);
    expect(chunks.err).toContain("approval gate is on");
    expect(chunks.err).toContain("vgen19 approve draft-1");
    expect(await store.loadSubmissions()).toEqual([]);
  });

  it("exits non-zero when the draft status is not approved", async () => {
    const store = await makeStore();
    await store.saveDraft(makeDraft({ status: "rejected" }));
    const { chunks, output } = captureOutput();
    const command = createSubmitCommand({
      adapter: new StubDelphiAdapter(),
      config: makeConfig(),
      now: () => FIXED_NOW,
      store,
    });

    const exitCode = await command.run(["draft-1"], output);

    expect(exitCode).not.toBe(0);
    expect(chunks.err).toContain('status is "rejected"');
  });

  it("exits non-zero with a clear message for an unknown draft", async () => {
    const store = await makeStore();
    const { chunks, output } = captureOutput();
    const command = createSubmitCommand({
      adapter: new StubDelphiAdapter(),
      config: makeConfig(),
      now: () => FIXED_NOW,
      store,
    });

    const exitCode = await command.run(["no-such-draft"], output);

    expect(exitCode).not.toBe(0);
    expect(chunks.err).toContain("Draft not found: no-such-draft");
  });

  it("prints usage and exits non-zero with no draft id", async () => {
    const store = await makeStore();
    const { chunks, output } = captureOutput();
    const command = createSubmitCommand({
      adapter: new StubDelphiAdapter(),
      config: makeConfig(),
      store,
    });

    const exitCode = await command.run([], output);

    expect(exitCode).not.toBe(0);
    expect(chunks.err).toContain("Usage: vgen19 submit <draft-id>");
  });

  it("exits non-zero on a rejected receipt and leaves the draft approved", async () => {
    const store = await makeStore();
    const draft = makeDraft();
    await store.saveDraft(draft);
    await store.saveApproval({
      approvedAt: "2026-11-20T15:30:00.000Z",
      approvedBy: "human",
      draftId: draft.id,
    });
    const adapter = new FakeDelphiAdapter({
      draftId: "draft-1",
      marketId: MARKET_A,
      rationale: "Duplicate evidence.",
      submissionId: "sub-1",
      submittedAt: "2026-11-20T16:00:00.000Z",
      verdict: "rejected",
    });
    const { chunks, output } = captureOutput();
    const command = createSubmitCommand({
      adapter,
      config: makeConfig(),
      now: () => FIXED_NOW,
      store,
    });

    const exitCode = await command.run(["draft-1"], output);

    expect(exitCode).not.toBe(0);
    expect(chunks.out).toContain("REJECTED");
    expect(chunks.out).toContain("Duplicate evidence.");
    expect(chunks.out).toContain("APPROVED");
    expect((await store.loadDraft("draft-1"))!.status).toBe("approved");
  });

  it("warns on stderr when the gate is disabled", async () => {
    const store = await makeStore();
    await store.saveDraft(makeDraft());
    const { chunks, output } = captureOutput();
    const command = createSubmitCommand({
      adapter: new StubDelphiAdapter(),
      config: makeConfig({ VGEN19_APPROVAL_GATE: "false" }),
      now: () => FIXED_NOW,
      store,
    });

    const exitCode = await command.run(["draft-1"], output);

    expect(exitCode).toBe(0);
    expect(chunks.err).toContain("approval gate is OFF");
  });

  it("registers the submit command with its name and description", () => {
    expect(submitCommand.name).toBe("submit");
    expect(submitCommand.description).toContain("Submit");
  });
});

describe("approve command", () => {
  it("records the approval and prints it, exiting 0", async () => {
    const store = await makeStore();
    await store.saveDraft(makeDraft());
    const { chunks, output } = captureOutput();
    const command = createApproveCommand({
      config: makeConfig(),
      now: () => FIXED_NOW,
      store,
    });

    const exitCode = await command.run(["draft-1", "--note", "Looks good."], output);

    expect(exitCode).toBe(0);
    expect(chunks.out).toContain("draft-1");
    expect(chunks.out).toContain("human");
    expect(chunks.out).toContain("2026-11-20T16:00:00.000Z");
    expect(chunks.out).toContain("Looks good.");
    expect(chunks.err).toBe("");
    const approval = await store.loadApproval("draft-1");
    expect(approval).toEqual({
      approvedAt: "2026-11-20T16:00:00.000Z",
      approvedBy: "human",
      draftId: "draft-1",
      note: "Looks good.",
    });
  });

  it("finds the draft id when --note comes first", async () => {
    const store = await makeStore();
    await store.saveDraft(makeDraft());
    const { chunks, output } = captureOutput();
    const command = createApproveCommand({
      config: makeConfig(),
      now: () => FIXED_NOW,
      store,
    });

    // The flag value ("Looks good.") must not be mistaken for the draft id.
    const exitCode = await command.run(
      ["--note", "Looks good.", "draft-1"],
      output,
    );

    expect(exitCode).toBe(0);
    expect((await store.loadApproval("draft-1"))!.note).toBe("Looks good.");
    expect(chunks.out).toContain("draft-1");
  });

  it("accepts --note=value and works without a note", async () => {
    const store = await makeStore();
    await store.saveDraft(makeDraft());
    const { chunks, output } = captureOutput();
    const command = createApproveCommand({
      config: makeConfig(),
      now: () => FIXED_NOW,
      store,
    });

    const exitCode = await command.run(["draft-1", "--note=Ship it."], output);

    expect(exitCode).toBe(0);
    expect((await store.loadApproval("draft-1"))!.note).toBe("Ship it.");
    expect(chunks.out).toContain("Ship it.");
  });

  it("exits non-zero with a clear message for an unknown draft", async () => {
    const store = await makeStore();
    const { chunks, output } = captureOutput();
    const command = createApproveCommand({
      config: makeConfig(),
      now: () => FIXED_NOW,
      store,
    });

    const exitCode = await command.run(["no-such-draft"], output);

    expect(exitCode).not.toBe(0);
    expect(chunks.err).toContain("Draft not found: no-such-draft");
  });

  it("prints usage and exits non-zero with no draft id", async () => {
    const store = await makeStore();
    const { chunks, output } = captureOutput();
    const command = createApproveCommand({
      config: makeConfig(),
      store,
    });

    const exitCode = await command.run([], output);

    expect(exitCode).not.toBe(0);
    expect(chunks.err).toContain("Usage: vgen19 approve <draft-id>");
  });

  it("registers the approve command with its name and description", () => {
    expect(approveCommand.name).toBe("approve");
    expect(approveCommand.description).toContain("Approve");
  });
});
