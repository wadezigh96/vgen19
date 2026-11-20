import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { CliOutput } from "../src/cli.js";
import { loadConfig } from "../src/config.js";
import { createSummaryCommand } from "../src/commands/summary.js";
import { fixtureMarkets } from "../src/delphi/fixtures.js";
import { MemoryStore } from "../src/memory/store.js";
import type { FinalSummary } from "../src/summary/types.js";

let tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vgen19-summary-command-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { force: true, recursive: true });
  }
  tempDirs = [];
});

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

async function seedDataDir(): Promise<string> {
  const dataDir = await makeTempDir();
  const store = new MemoryStore(dataDir);
  const market = fixtureMarkets[0]!;
  await store.saveMarkets([market]);
  await store.saveSubmission({
    cycleId: "cycle-1",
    draftId: "draft-sub-1",
    id: "sub-1",
    marketId: market.id,
    receipt: {
      draftId: "draft-sub-1",
      marketId: market.id,
      submissionId: "sub-1",
      submittedAt: "2026-11-24T02:30:00.000Z",
      verdict: "accepted",
    },
    recordedAt: "2026-11-24T02:30:00.000Z",
    status: "accepted",
  });
  await store.saveReward({
    currency: "USDC",
    draftId: "draft-sub-1",
    judgment: 0.42,
    marketId: market.id,
    recordedAt: "2026-11-24T03:00:00.000Z",
    submissionId: "sub-1",
  });
  return dataDir;
}

describe("summary command", () => {
  it("writes final-summary.md and prints a one-paragraph summary, exit 0", async () => {
    const dataDir = await seedDataDir();
    const config = loadConfig({ VGEN19_DATA_DIR: dataDir });
    const { chunks, output } = captureOutput();
    const command = createSummaryCommand({ config });

    const exitCode = await command.run([], output);

    expect(exitCode).toBe(0);
    expect(chunks.err).toBe("");
    expect(chunks.out).toContain("1 submission");
    expect(chunks.out).toContain("1 pasar");
    expect(chunks.out).toContain("0.42 USDC");
    expect(chunks.out).toContain(join(dataDir, "final-summary.md"));
    const report = await readFile(
      join(dataDir, "final-summary.md"),
      "utf-8",
    );
    expect(report).toContain("# Ringkasan akhir kompetisi");
    expect(report).toContain("1 submission");
  });

  it("prints the aggregated data as JSON with --json", async () => {
    const dataDir = await seedDataDir();
    const config = loadConfig({ VGEN19_DATA_DIR: dataDir });
    const { chunks, output } = captureOutput();
    const command = createSummaryCommand({ config });

    const exitCode = await command.run(["--json"], output);

    expect(exitCode).toBe(0);
    const summary = JSON.parse(chunks.out) as FinalSummary;
    expect(summary.totals.submissions).toBe(1);
    expect(summary.totals.totalReward).toBeCloseTo(0.42, 10);
    expect(summary.totals.marketsCovered).toBe(1);
    // --json still writes the report file.
    const report = await readFile(
      join(dataDir, "final-summary.md"),
      "utf-8",
    );
    expect(report).toContain("1 submission");
  });

  it("works on an empty data dir (zero cycles, zero submissions)", async () => {
    const dataDir = await makeTempDir();
    const config = loadConfig({ VGEN19_DATA_DIR: dataDir });
    const { chunks, output } = captureOutput();
    const command = createSummaryCommand({ config });

    const exitCode = await command.run([], output);

    expect(exitCode).toBe(0);
    expect(chunks.out).toContain("0 submission");
    const report = await readFile(
      join(dataDir, "final-summary.md"),
      "utf-8",
    );
    expect(report).toContain("Tidak ada kegagalan.");
  });
});
