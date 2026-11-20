import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { cycleTracePath, TraceWriter } from "../src/cycle/trace.js";

let tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vgen19-cycle-trace-test-"));
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

describe("TraceWriter", () => {
  it("writes one valid JSON object per line with the required fields", async () => {
    const dataDir = await makeTempDir();
    const trace = new TraceWriter(dataDir, "cycle-test-1", () => FIXED_NOW);

    trace.write("cycle-start", { detail: { dryRun: false } });
    trace.write("market-sync", { detail: { checked: 4 } });
    trace.write("receipt", {
      detail: { verdict: "accepted" },
      draftId: "draft-1",
      marketId: "market-1",
      submissionId: "submission-1",
    });

    const raw = await readFile(trace.path, "utf-8");
    const lines = raw.trim().split("\n");
    expect(lines).toHaveLength(3);
    const entries = lines.map(
      (line) => JSON.parse(line) as Record<string, unknown>,
    );
    expect(entries[0]).toEqual({
      cycleId: "cycle-test-1",
      detail: { dryRun: false },
      step: "cycle-start",
      ts: "2026-11-20T10:00:00.000Z",
    });
    expect(entries[1]?.["step"]).toBe("market-sync");
    expect(entries[2]).toMatchObject({
      draftId: "draft-1",
      marketId: "market-1",
      step: "receipt",
      submissionId: "submission-1",
    });
  });

  it("creates the traces directory when it is missing", async () => {
    const dataDir = await makeTempDir();
    const trace = new TraceWriter(dataDir, "cycle-test-2", () => FIXED_NOW);

    trace.write("cycle-start");

    expect(trace.path).toBe(join(dataDir, "traces", "cycle-test-2.jsonl"));
    const raw = await readFile(trace.path, "utf-8");
    expect(raw.trim().split("\n")).toHaveLength(1);
  });

  it("appends to an existing trace file instead of overwriting it", async () => {
    const dataDir = await makeTempDir();
    const first = new TraceWriter(dataDir, "cycle-test-3", () => FIXED_NOW);
    first.write("cycle-start");

    const second = new TraceWriter(dataDir, "cycle-test-3", () => FIXED_NOW);
    second.write("cycle-end", { detail: { status: "completed" } });

    const raw = await readFile(first.path, "utf-8");
    const lines = raw.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)["step"]).toBe("cycle-start");
    expect(JSON.parse(lines[1]!)["step"]).toBe("cycle-end");
  });

  it("exposes the trace path helper used by the report", async () => {
    const dataDir = await makeTempDir();

    expect(cycleTracePath(dataDir, "cycle-x")).toBe(
      join(dataDir, "traces", "cycle-x.jsonl"),
    );
  });

  it("refuses a cycle id that would escape the data dir", async () => {
    const dataDir = await makeTempDir();

    expect(() => cycleTracePath(dataDir, "../../x")).toThrow(/cycle id/i);
    expect(() => cycleTracePath(dataDir, "")).toThrow(/cycle id/i);
  });
});
