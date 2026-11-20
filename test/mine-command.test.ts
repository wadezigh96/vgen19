import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { CliOutput } from "../src/cli.js";
import { StubDelphiAdapter } from "../src/delphi/stub.js";
import { createMineCommand } from "../src/commands/mine.js";
import type { CycleDeps } from "../src/cycle/runner.js";
import type { CycleSummary } from "../src/cycle/report.js";
import { FakeModelProvider } from "../src/llm/fake.js";
import { RoutedModelClient } from "../src/llm/client.js";
import { MemoryStore } from "../src/memory/store.js";
import { FakeSearchProvider } from "../src/search/fake.js";

let tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vgen19-mine-command-test-"));
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
  throw new Error(`Unexpected model call in mine test: ${system.slice(0, 80)}`);
}

function captureOutput(): {
  chunks: { err: string; out: string };
  output: CliOutput;
} {
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

async function makeCycleDeps(
  overrides: Partial<CycleDeps> = {},
): Promise<{ adapter: StubDelphiAdapter; deps: CycleDeps; store: MemoryStore }> {
  const dataDir = await makeTempDir();
  const store = new MemoryStore(dataDir);
  const fakeModel = new FakeModelProvider({ replyFor: replyForCallKind });
  const adapter = new StubDelphiAdapter();
  let counter = 0;
  const deps: CycleDeps = {
    adapter,
    approvalGate: false,
    createId: () => {
      counter += 1;
      return `draft-${counter}`;
    },
    dataDir,
    model: new RoutedModelClient({
      models: { primary: { fast: "fake-fast", strong: "fake-strong" } },
      primary: fakeModel,
    }),
    now: () => FIXED_NOW,
    readPage: async (url: string) => ({
      text: "The Zanara Election Commission announced a general election for 31 December 2026.",
      url,
    }),
    search: new FakeSearchProvider({
      results: [
        {
          snippet: "The Zanara Election Commission announced an election.",
          title: "Zanara election announced",
          url: ELECTION_URL,
        },
      ],
    }),
    store,
    warn: () => {},
    ...overrides,
  };
  return { adapter, deps, store };
}

describe("mine command", () => {
  it("runs a full cycle and prints a one-paragraph summary, exit 0", async () => {
    const { deps, store } = await makeCycleDeps({ cycleId: "cycle-mine-1" });
    const { chunks, output } = captureOutput();
    const command = createMineCommand({ cycleDeps: deps });

    const exitCode = await command.run([], output);

    expect(exitCode).toBe(0);
    expect(chunks.err).toBe("");
    expect(chunks.out).toContain("cycle-mine-1");
    expect(chunks.out).toContain("5 pasar");
    expect(chunks.out).toContain("4 draf");
    expect(chunks.out).toContain("4 submission");
    expect((await store.loadSubmissions())).toHaveLength(4);
    const report = await readFile(
      join(deps.dataDir, "reports", "cycle-mine-1.md"),
      "utf-8",
    );
    expect(report).toContain("cycle-mine-1");
  });

  it("prints the cycle summary as JSON with --json", async () => {
    const { deps } = await makeCycleDeps({ cycleId: "cycle-mine-2" });
    const { chunks, output } = captureOutput();
    const command = createMineCommand({ cycleDeps: deps });

    const exitCode = await command.run(["--json"], output);

    expect(exitCode).toBe(0);
    const summary = JSON.parse(chunks.out) as CycleSummary;
    expect(summary.cycleId).toBe("cycle-mine-2");
    expect(summary.submissions).toHaveLength(4);
    expect(summary.status).toBe("completed");
  });

  it("uses the cycle id from --cycle", async () => {
    const { deps } = await makeCycleDeps({});
    const { chunks, output } = captureOutput();
    const command = createMineCommand({ cycleDeps: deps });

    const exitCode = await command.run(["--cycle", "cycle-named"], output);

    expect(exitCode).toBe(0);
    expect(chunks.out).toContain("cycle-named");
    const report = await readFile(
      join(deps.dataDir, "reports", "cycle-named.md"),
      "utf-8",
    );
    expect(report).toContain("cycle-named");
  });

  it("exits non-zero for a cycle id that would escape the data dir", async () => {
    const { deps } = await makeCycleDeps({});
    const { chunks, output } = captureOutput();
    const command = createMineCommand({ cycleDeps: deps });

    const exitCode = await command.run(["--cycle", "../../x"], output);

    expect(exitCode).toBe(1);
    expect(chunks.err).toMatch(/cycle id/i);
  });

  it("in dry-run mode drafts without submitting", async () => {
    const { adapter, deps } = await makeCycleDeps({
      cycleId: "cycle-mine-dry",
    });
    const { chunks, output } = captureOutput();
    const command = createMineCommand({ cycleDeps: deps });

    const exitCode = await command.run(["--dry-run"], output);

    expect(exitCode).toBe(0);
    expect(adapter.recordedSubmissions).toHaveLength(0);
    expect(chunks.out).toMatch(/dry-run/i);
  });

  it("exits non-zero when the cycle fails operationally", async () => {
    const { deps } = await makeCycleDeps({ cycleId: "cycle-mine-fail" });
    const failingAdapter = new StubDelphiAdapter();
    failingAdapter.listMarkets = async () => {
      throw new Error("Delphi unreachable");
    };
    deps.adapter = failingAdapter;
    const { chunks, output } = captureOutput();
    const command = createMineCommand({ cycleDeps: deps });

    const exitCode = await command.run([], output);

    expect(exitCode).not.toBe(0);
    expect(chunks.err).toContain("mine failed");
    expect(chunks.err).toContain("Delphi unreachable");
  });

  it("exits 0 on an empty cycle (zero drafts, zero submissions)", async () => {
    const { deps } = await makeCycleDeps({ cycleId: "cycle-mine-empty" });
    // An adapter that lists only the settled fixture market: nothing
    // is open, so the cycle picks nothing and still completes.
    const settledOnly = new StubDelphiAdapter();
    const originalList = settledOnly.listMarkets.bind(settledOnly);
    settledOnly.listMarkets = async (params) => {
      const markets = await originalList(params);
      return markets.filter((market) => market.status !== "open");
    };
    deps.adapter = settledOnly;
    const { chunks, output } = captureOutput();
    const command = createMineCommand({ cycleDeps: deps });

    const exitCode = await command.run([], output);

    expect(exitCode).toBe(0);
    expect(chunks.out).toContain("0 draf");
    expect(chunks.out).toContain("0 submission");
  });
});
