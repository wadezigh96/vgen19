import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

interface ScheduleDefinition {
  window: { start: string; end: string };
  cycles: Array<{ timeUtc: string; label: string }>;
  command: string;
  notes: string;
}

async function loadSchedule(): Promise<ScheduleDefinition> {
  const raw = await readFile(
    join(REPO_ROOT, "scripts", "schedule.json"),
    "utf-8",
  );
  return JSON.parse(raw) as ScheduleDefinition;
}

describe("schedule definition", () => {
  it("covers the competition window, 23 November to 11 December", async () => {
    const schedule = await loadSchedule();

    expect(schedule.window.start).toBe("2026-11-23T17:00:00Z");
    expect(schedule.window.end).toBe("2026-12-11T17:00:00Z");
  });

  it("runs exactly 2 cycles per day, at 02:00 and 14:00 UTC", async () => {
    const schedule = await loadSchedule();

    expect(schedule.cycles).toHaveLength(2);
    expect(schedule.cycles.map((cycle) => cycle.timeUtc)).toEqual([
      "02:00",
      "14:00",
    ]);
    expect(schedule.cycles.map((cycle) => cycle.label)).toEqual([
      "morning",
      "afternoon",
    ]);
  });

  it("runs the run script as its command", async () => {
    const schedule = await loadSchedule();

    expect(schedule.command).toBe("bash scripts/run-cycle.sh");
  });

  it("documents the quota math and that the main agent installs it", async () => {
    const schedule = await loadSchedule();

    // The binding constraint is the strong-model daily budget: 2
    // cycles/day x ~10 strong calls fits the ~20/day Flash budget,
    // and a 3rd cycle/day would exceed it.
    expect(schedule.notes).toContain("20");
    expect(schedule.notes).toContain("Gemini");
    expect(schedule.notes).toContain("Tavily");
    expect(schedule.notes).toMatch(/main agent installs/i);
    expect(schedule.notes).toMatch(/idempotent/i);
  });
});
