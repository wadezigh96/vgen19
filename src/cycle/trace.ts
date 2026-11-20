/**
 * The cycle trace: a JSONL log of every step a mining cycle took, so
 * that any submission can be explained afterwards (spec story 25).
 *
 * One JSON object per line, appended to
 * `<data-dir>/traces/<cycle-id>.jsonl`. Every write is a synchronous
 * append, flushed before the call returns, so an interrupted cycle
 * keeps its trace up to the interruption: the trace is append-only
 * and never rewritten.
 *
 * Never write secrets to the trace: steps carry ids, counts, and
 * verdicts only, never keys, tokens, or credentials.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { assertValidCycleId } from "../util.js";

/** Every step a mining cycle can trace, in cycle order. */
export type TraceStep =
  /** The cycle started. */
  | "cycle-start"
  /** The cycle ended (completed, interrupted, or budget-exhausted). */
  | "cycle-end"
  /** Markets were synced from Delphi into memory. */
  | "market-sync"
  /** Target markets were picked (picked plus skipped with reasons). */
  | "market-pick"
  /** Work on one market started. */
  | "market-start"
  /** Work on one market finished. */
  | "market-end"
  /** Research for one market started. */
  | "research-start"
  /** Research for one market finished (findings count). */
  | "research-end"
  /** A draft was created and reviewed (review score in the detail). */
  | "draft-created"
  /** No draft was produced for a market (reason in the detail). */
  | "no-draft"
  /** The approval gate decided whether a draft may be submitted. */
  | "approval-decision"
  /** A submission attempt started. */
  | "submission-attempt"
  /** Delphi returned a receipt (verdict in the detail). */
  | "receipt"
  /** A submission attempt was refused before anything was sent. */
  | "refusal"
  /** Something failed (message in the detail). */
  | "error";

/** One line of the trace file. */
export interface TraceEntry {
  /** ISO timestamp when the step happened. */
  ts: string;
  /** Id of the mining cycle. */
  cycleId: string;
  /** Which step happened. */
  step: TraceStep;
  /** Market the step concerns, when it concerns one. */
  marketId?: string;
  /** Draft the step concerns, when it concerns one. */
  draftId?: string;
  /** Submission the step concerns, when it concerns one. */
  submissionId?: string;
  /** Step-specific detail: counts, verdicts, reasons. Never secrets. */
  detail?: Record<string, unknown>;
}

/** Path of the trace file for one cycle. */
export function cycleTracePath(dataDir: string, cycleId: string): string {
  assertValidCycleId(cycleId);
  return join(dataDir, "traces", `${cycleId}.jsonl`);
}

export class TraceWriter {
  /** Path of the trace file this writer appends to. */
  readonly path: string;
  private readonly cycleId: string;
  private readonly now: () => Date;

  constructor(
    dataDir: string,
    cycleId: string,
    now: () => Date = () => new Date(),
  ) {
    this.cycleId = cycleId;
    this.now = now;
    this.path = cycleTracePath(dataDir, cycleId);
    mkdirSync(join(dataDir, "traces"), { recursive: true });
  }

  /**
   * Append one step to the trace, synchronously. The write is
   * flushed before this returns, so a crash right after loses at
   * most the steps that had not happened yet.
   */
  write(
    step: TraceStep,
    fields: {
      marketId?: string;
      draftId?: string;
      submissionId?: string;
      detail?: Record<string, unknown>;
    } = {},
  ): void {
    const entry: TraceEntry = {
      cycleId: this.cycleId,
      step,
      ts: this.now().toISOString(),
      ...(fields.marketId !== undefined
        ? { marketId: fields.marketId }
        : {}),
      ...(fields.draftId !== undefined ? { draftId: fields.draftId } : {}),
      ...(fields.submissionId !== undefined
        ? { submissionId: fields.submissionId }
        : {}),
      ...(fields.detail !== undefined ? { detail: fields.detail } : {}),
    };
    appendFileSync(this.path, `${JSON.stringify(entry)}\n`, "utf-8");
  }
}
