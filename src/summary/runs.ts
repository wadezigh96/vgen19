/**
 * The scheduled-run index: `<data-dir>/runs/index.jsonl`, one JSON
 * object per line, appended by the run script (scripts/run-cycle.sh)
 * after every scheduled cycle, plus the per-run log files.
 *
 * The reader is tolerant: a missing index means no scheduled runs
 * yet, and a malformed line is skipped (a corrupt line must not
 * hide the runs around it). The writer is the shell script, not
 * this module.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { RunIndexEntry } from "./types.js";

/** Path of the run index file. */
export function runIndexPath(dataDir: string): string {
  return join(dataDir, "runs", "index.jsonl");
}

/** Path of one cycle's per-run log file. */
export function runLogPath(dataDir: string, cycleId: string): string {
  return join(dataDir, "runs", `${cycleId}.log`);
}

function isRunIndexEntry(value: unknown): value is RunIndexEntry {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const entry = value as Record<string, unknown>;
  return (
    typeof entry["cycleId"] === "string" &&
    typeof entry["startedAt"] === "string" &&
    typeof entry["finishedAt"] === "string" &&
    typeof entry["exitCode"] === "number" &&
    (entry["status"] === "ok" || entry["status"] === "failed") &&
    typeof entry["logPath"] === "string"
  );
}

/**
 * Read the run index: every scheduled run the script recorded, in
 * file order. Empty when the index does not exist yet; malformed
 * lines are skipped.
 */
export async function readRunIndex(dataDir: string): Promise<RunIndexEntry[]> {
  let raw: string;
  try {
    raw = await readFile(runIndexPath(dataDir), "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const entries: RunIndexEntry[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(line);
      if (isRunIndexEntry(parsed)) {
        entries.push(parsed);
      }
    } catch {
      // A malformed line is skipped, never fatal.
    }
  }
  return entries;
}
