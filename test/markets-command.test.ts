import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli, type CliOutput } from "../src/cli.js";
import { fixtureMarkets } from "../src/delphi/fixtures.js";
import type { Market } from "../src/delphi/types.js";
import { MemoryStore } from "../src/memory/store.js";

let tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vgen19-markets-cmd-test-"));
  tempDirs.push(dir);
  return dir;
}

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

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const dir of tempDirs) {
    await rm(dir, { force: true, recursive: true });
  }
  tempDirs = [];
});

/**
 * Expected close times, as literals: the metadata end date when the
 * fixture carries one, otherwise the scheduled settlement time
 * (Quantleaf has no end date in its metadata).
 */
const EXPECTED_CLOSE_TIMES = [
  "2026-12-31T00:00:00.000Z",
  "2027-03-01T00:00:00.000Z",
  "2027-06-15T00:00:00.000Z",
  "2027-06-01T00:00:00.000Z",
  "2028-01-01T00:00:00.000Z",
];

describe("CLI markets command", () => {
  it("shows markets with odds, close time, cutoff, and reward pot, and exits 0", async () => {
    const dataDir = await makeTempDir();
    vi.stubEnv("VGEN19_DATA_DIR", dataDir);
    const { chunks, output } = captureOutput();

    const exitCode = await runCli(["markets"], output);

    expect(exitCode).toBe(0);
    expect(chunks.err).toBe("");
    for (const [index, market] of fixtureMarkets.entries()) {
      expect(chunks.out).toContain(market.metadata!.question!);
      expect(chunks.out).toContain(EXPECTED_CLOSE_TIMES[index]!);
      if (market.competition !== undefined) {
        expect(chunks.out).toContain(market.competition.evidenceCutoff!);
        expect(chunks.out).toContain(String(market.competition.rewardPot));
      }
    }
    expect(chunks.out).toContain("62%");
    expect(chunks.out).toContain("38%");
    // The close time comes from the metadata end date, not the later
    // scheduled settlement time.
    expect(chunks.out).not.toContain("2027-01-07T00:00:00.000Z");
  });

  it("shows n/a for the competition fields of a market without them", async () => {
    const dataDir = await makeTempDir();
    vi.stubEnv("VGEN19_DATA_DIR", dataDir);
    const { chunks, output } = captureOutput();

    await runCli(["markets"], output);

    const lines = chunks.out.split("\n");
    const questionLine = lines.findIndex((line) =>
      line.includes("Will Northgate Rovers win the 2027 Aurora Cup?"),
    );
    expect(questionLine).toBeGreaterThanOrEqual(0);
    const detailLine = lines[questionLine + 1]!;
    expect(detailLine).toContain("Yes n/a / No n/a");
    expect(detailLine).toContain("Cutoff n/a");
    expect(detailLine).toContain("Pot n/a");
    expect(detailLine).toContain("awaiting_settlement");
  });

  it("persists the synced markets in the memory store", async () => {
    const dataDir = await makeTempDir();
    vi.stubEnv("VGEN19_DATA_DIR", dataDir);
    const { output } = captureOutput();

    await runCli(["markets"], output);

    const store = new MemoryStore(dataDir);
    expect(await store.loadMarkets()).toEqual(fixtureMarkets);
  });

  it("supports --json for machine-readable output", async () => {
    const dataDir = await makeTempDir();
    vi.stubEnv("VGEN19_DATA_DIR", dataDir);
    const { chunks, output } = captureOutput();

    const exitCode = await runCli(["markets", "--json"], output);

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(chunks.out) as Market[];
    expect(parsed).toEqual(fixtureMarkets);
  });

  it("appears in the help listing", async () => {
    const { chunks, output } = captureOutput();

    await runCli(["help"], output);

    expect(chunks.out).toContain("markets");
  });

  it("reports a sync failure with the markets prefix, like the other commands", async () => {
    // A data dir that is a file, not a directory: the store cannot
    // write into it, so the sync fails.
    const dataDir = await makeTempDir();
    const filePath = join(dataDir, "not-a-dir");
    await writeFile(filePath, "not a directory\n", "utf-8");
    vi.stubEnv("VGEN19_DATA_DIR", filePath);
    const { chunks, output } = captureOutput();

    const exitCode = await runCli(["markets"], output);

    expect(exitCode).toBe(1);
    expect(chunks.err).toMatch(/^markets failed: /);
  });
});
