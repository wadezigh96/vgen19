import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli, type CliOutput } from "../src/cli.js";
import { createDraftCommand } from "../src/commands/draft.js";
import { fixtureMarkets } from "../src/delphi/fixtures.js";
import type { EvidenceDraft } from "../src/draft/index.js";
import type { DraftPipelineDeps } from "../src/draft/index.js";
import { FakeModelProvider } from "../src/llm/fake.js";
import { RoutedModelClient } from "../src/llm/client.js";
import { MemoryStore } from "../src/memory/store.js";
import type { ResearchNotes } from "../src/research/index.js";
import { FakeSearchProvider } from "../src/search/index.js";

let tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vgen19-draft-cmd-test-"));
  tempDirs.push(dir);
  return dir;
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

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const dir of tempDirs) {
    await rm(dir, { force: true, recursive: true });
  }
  tempDirs = [];
});

const MARKET = fixtureMarkets[0]!;
const ELECTION_URL = "https://example.invalid/news/zanara-election";
const CLAIM =
  "The Zanara Election Commission announced a general election for 31 December 2026.";
const FIXED_NOW = new Date("2026-11-20T10:00:00.000Z");

function extractionReply(): string {
  return JSON.stringify({
    findings: [{ claim: CLAIM, date: "2025-03-11" }],
  });
}

function draftReply(): string {
  return JSON.stringify({
    links: [{ title: "Zanara election announced", url: ELECTION_URL }],
    note: "The Zanara Election Commission announced a general election for 31 December 2026 (2025-03-11).",
  });
}

function judgeReply(score: number): string {
  return JSON.stringify({
    noInventedFacts: { rationale: "Judge: supported.", score },
    novel: { rationale: "Judge: new.", score },
    relevant: { rationale: "Judge: relevant.", score },
    sourced: { rationale: "Judge: cited.", score },
  });
}

function notesWithFindings(): ResearchNotes {
  return {
    compacted: false,
    failedSources: [],
    fetchedAt: "2026-11-20T09:00:00.000Z",
    findings: [
      {
        claim: CLAIM,
        date: "2025-03-11",
        sourceTitle: "Zanara election announced",
        sourceUrl: ELECTION_URL,
      },
    ],
    marketId: MARKET.id,
    question:
      "Will the Republic of Zanara hold a general election before 31 December 2026?",
  };
}

async function storedMarketDir(): Promise<string> {
  const dataDir = await makeTempDir();
  const store = new MemoryStore(dataDir);
  await store.saveMarkets([MARKET]);
  vi.stubEnv("VGEN19_DATA_DIR", dataDir);
  return dataDir;
}

function routedClient(fake: FakeModelProvider): RoutedModelClient {
  return new RoutedModelClient({
    models: { primary: { fast: "fake-fast", strong: "fake-strong" } },
    primary: fake,
  });
}

function fakeDeps(
  dataDir: string,
  modelScript: string[],
): Omit<DraftPipelineDeps, "market"> {
  return {
    createId: () => "draft-1",
    model: routedClient(
      new FakeModelProvider({
        script: modelScript.map((text) => ({ text })),
      }),
    ),
    now: () => FIXED_NOW,
    readPage: async (url: string) => ({
      text: "The Zanara Election Commission announced a general election for 31 December 2026.",
      url,
    }),
    search: new FakeSearchProvider({
      results: [
        {
          publishedDate: "Tue, 11 Mar 2025 17:00:00 GMT",
          snippet: "The Zanara Election Commission announced an election.",
          title: "Zanara election announced",
          url: ELECTION_URL,
        },
      ],
    }),
    store: new MemoryStore(dataDir),
  };
}

describe("CLI draft command", () => {
  it("drafts from stored notes, prints the draft with scores, and saves it", async () => {
    const dataDir = await storedMarketDir();
    const store = new MemoryStore(dataDir);
    await store.saveResearchNotes(notesWithFindings());
    const { chunks, output } = captureOutput();
    const command = createDraftCommand({
      pipelineDeps: fakeDeps(dataDir, [draftReply(), judgeReply(1)]),
    });

    const exitCode = await command.run([MARKET.id], output);

    expect(exitCode).toBe(0);
    expect(chunks.err).toBe("");
    expect(chunks.out).toContain("general election for 31 December 2026");
    expect(chunks.out).toContain(ELECTION_URL);
    expect(chunks.out).toContain("sourced");
    expect(chunks.out).toContain("noInventedFacts");
    expect(chunks.out).toContain("APPROVED");
    expect(chunks.out).toContain("PASS");

    const saved = await store.loadDraft("draft-1");
    expect(saved?.status).toBe("approved");
    expect(saved?.score?.passed).toBe(true);
    expect(saved?.score?.overall).toBeCloseTo(1);
  });

  it("runs the research loop first when no notes exist", async () => {
    const dataDir = await storedMarketDir();
    const { chunks, output } = captureOutput();
    const command = createDraftCommand({
      pipelineDeps: fakeDeps(dataDir, [
        extractionReply(),
        draftReply(),
        judgeReply(1),
      ]),
    });

    const exitCode = await command.run([MARKET.id], output);

    expect(exitCode).toBe(0);
    expect(chunks.out).toContain("general election for 31 December 2026");
    expect(chunks.out).toContain("APPROVED");

    const store = new MemoryStore(dataDir);
    const notes = await store.loadResearchNotes(MARKET.id);
    expect(notes?.findings).toHaveLength(1);
    const saved = await store.loadDraft("draft-1");
    expect(saved?.status).toBe("approved");
  });

  it("exits 0 for a rejected draft: rejection is a normal outcome, and the draft is kept", async () => {
    const dataDir = await storedMarketDir();
    const store = new MemoryStore(dataDir);
    await store.saveResearchNotes(notesWithFindings());
    const { chunks, output } = captureOutput();
    const command = createDraftCommand({
      pipelineDeps: fakeDeps(dataDir, [draftReply(), judgeReply(0.2)]),
    });

    const exitCode = await command.run([MARKET.id], output);

    expect(exitCode).toBe(0);
    expect(chunks.err).toBe("");
    expect(chunks.out).toContain("REJECTED");
    expect(chunks.out).toContain("FAIL");

    const saved = await store.loadDraft("draft-1");
    expect(saved?.status).toBe("rejected");
    expect(saved?.score?.passed).toBe(false);
  });

  it("reports no draft when the research finds nothing, and exits 0", async () => {
    const dataDir = await storedMarketDir();
    const { chunks, output } = captureOutput();
    const deps = fakeDeps(dataDir, []);
    deps.search = new FakeSearchProvider({ results: [] });
    const command = createDraftCommand({ pipelineDeps: deps });

    const exitCode = await command.run([MARKET.id], output);

    expect(exitCode).toBe(0);
    expect(chunks.out).toContain("no draft: no findings");
    const store = new MemoryStore(dataDir);
    expect(await store.loadDrafts(MARKET.id)).toHaveLength(0);
  });

  it("supports --json for machine-readable output", async () => {
    const dataDir = await storedMarketDir();
    const store = new MemoryStore(dataDir);
    await store.saveResearchNotes(notesWithFindings());
    const { chunks, output } = captureOutput();
    const command = createDraftCommand({
      pipelineDeps: fakeDeps(dataDir, [draftReply(), judgeReply(1)]),
    });

    const exitCode = await command.run([MARKET.id, "--json"], output);

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(chunks.out) as EvidenceDraft;
    expect(parsed.id).toBe("draft-1");
    expect(parsed.marketId).toBe(MARKET.id);
    expect(parsed.status).toBe("approved");
    expect(parsed.score?.passed).toBe(true);
  });

  it("accepts --dry-run and says the draft will not be submitted", async () => {
    const dataDir = await storedMarketDir();
    const store = new MemoryStore(dataDir);
    await store.saveResearchNotes(notesWithFindings());
    const { chunks, output } = captureOutput();
    const command = createDraftCommand({
      pipelineDeps: fakeDeps(dataDir, [draftReply(), judgeReply(1)]),
    });

    const exitCode = await command.run([MARKET.id, "--dry-run"], output);

    expect(exitCode).toBe(0);
    expect(chunks.out).toContain("dry-run");
    expect(chunks.out).toContain("will not be submitted");
    const saved = await store.loadDraft("draft-1");
    expect(saved?.status).toBe("approved");
  });

  it("fails clearly for an unknown market, telling the operator to run markets first", async () => {
    const dataDir = await storedMarketDir();
    const { chunks, output } = captureOutput();
    const command = createDraftCommand({
      pipelineDeps: fakeDeps(dataDir, [draftReply(), judgeReply(1)]),
    });

    const exitCode = await command.run(
      ["0x00000000000000000000000000000000000000ff"],
      output,
    );

    expect(exitCode).toBe(1);
    expect(chunks.out).toBe("");
    expect(chunks.err).toContain("0x00000000000000000000000000000000000000ff");
    expect(chunks.err).toContain("markets");
  });

  it("fails clearly when no market id is given", async () => {
    await storedMarketDir();
    const { chunks, output } = captureOutput();
    const command = createDraftCommand();

    const exitCode = await command.run([], output);

    expect(exitCode).toBe(1);
    expect(chunks.err).toContain("draft <market-id>");
  });

  it("fails closed when the search key and the model key are both missing and no notes exist", async () => {
    await storedMarketDir();
    vi.stubEnv("TAVILY_API_KEY", "");
    vi.stubEnv("GEMINI_API_KEY", "");
    vi.stubEnv("OPENROUTER_API_KEY", "");
    const { chunks, output } = captureOutput();
    const command = createDraftCommand();

    const exitCode = await command.run([MARKET.id], output);

    expect(exitCode).toBe(1);
    expect(chunks.err).toContain("TAVILY_API_KEY");
    expect(chunks.err).toContain("GEMINI_API_KEY");
  });

  it("appears in the help listing", async () => {
    const { chunks, output } = captureOutput();

    await runCli(["help"], output);

    expect(chunks.out).toContain("draft");
  });
});
