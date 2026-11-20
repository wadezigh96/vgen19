import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli, type CliOutput } from "../src/cli.js";
import { createResearchCommand } from "../src/commands/research.js";
import { fixtureMarkets } from "../src/delphi/fixtures.js";
import { FakeModelProvider } from "../src/llm/fake.js";
import { RoutedModelClient } from "../src/llm/client.js";
import { MemoryStore } from "../src/memory/store.js";
import type { ResearcherDeps } from "../src/research/index.js";
import type { ResearchNotes } from "../src/research/index.js";
import { FakeSearchProvider } from "../src/search/index.js";

let tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vgen19-research-cmd-test-"));
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

async function storedMarketDir(): Promise<string> {
  const dataDir = await makeTempDir();
  const store = new MemoryStore(dataDir);
  await store.saveMarkets([MARKET]);
  vi.stubEnv("VGEN19_DATA_DIR", dataDir);
  return dataDir;
}

function fakeDeps(dataDir: string): ResearcherDeps {
  const fakeModel = new FakeModelProvider({
    script: [
      {
        text: JSON.stringify({
          findings: [
            {
              claim:
                "The Zanara Election Commission announced a general election for 31 December 2026.",
              date: "2025-03-11",
            },
          ],
        }),
      },
    ],
  });
  return {
    model: new RoutedModelClient({
      models: { primary: { fast: "fake-fast", strong: "fake-strong" } },
      primary: fakeModel,
    }),
    now: () => new Date("2026-11-20T10:00:00.000Z"),
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

describe("CLI research command", () => {
  it("researches one market, prints dated notes with links, and saves them", async () => {
    const dataDir = await storedMarketDir();
    const { chunks, output } = captureOutput();
    const command = createResearchCommand({
      researcherDeps: fakeDeps(dataDir),
    });

    const exitCode = await command.run([MARKET.id], output);

    expect(exitCode).toBe(0);
    expect(chunks.err).toBe("");
    expect(chunks.out).toContain(MARKET.metadata!.question!);
    expect(chunks.out).toContain(
      "The Zanara Election Commission announced a general election for 31 December 2026.",
    );
    expect(chunks.out).toContain("2025-03-11");
    expect(chunks.out).toContain(ELECTION_URL);

    const store = new MemoryStore(dataDir);
    const saved = await store.loadResearchNotes(MARKET.id);
    expect(saved?.marketId).toBe(MARKET.id);
    expect(saved?.findings).toHaveLength(1);
  });

  it("supports --json for machine-readable output", async () => {
    const dataDir = await storedMarketDir();
    const { chunks, output } = captureOutput();
    const command = createResearchCommand({
      researcherDeps: fakeDeps(dataDir),
    });

    const exitCode = await command.run([MARKET.id, "--json"], output);

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(chunks.out) as ResearchNotes;
    expect(parsed.marketId).toBe(MARKET.id);
    expect(parsed.findings).toHaveLength(1);
    expect(parsed.findings[0]!.sourceUrl).toBe(ELECTION_URL);
  });

  it("fails clearly for an unknown market, telling the operator to run markets first", async () => {
    const dataDir = await storedMarketDir();
    const { chunks, output } = captureOutput();
    const command = createResearchCommand({
      researcherDeps: fakeDeps(dataDir),
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
    const command = createResearchCommand();

    const exitCode = await command.run([], output);

    expect(exitCode).toBe(1);
    expect(chunks.err).toContain("research <market-id>");
  });

  it("fails closed when the search key and the model key are both missing", async () => {
    await storedMarketDir();
    vi.stubEnv("TAVILY_API_KEY", "");
    vi.stubEnv("GEMINI_API_KEY", "");
    vi.stubEnv("OPENROUTER_API_KEY", "");
    const { chunks, output } = captureOutput();
    const command = createResearchCommand();

    const exitCode = await command.run([MARKET.id], output);

    expect(exitCode).toBe(1);
    expect(chunks.err).toContain("TAVILY_API_KEY");
    expect(chunks.err).toContain("GEMINI_API_KEY");
  });

  it("appears in the help listing", async () => {
    const { chunks, output } = captureOutput();

    await runCli(["help"], output);

    expect(chunks.out).toContain("research");
  });
});
