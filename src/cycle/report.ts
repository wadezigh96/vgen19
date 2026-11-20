/**
 * The per-cycle report (spec story 16): a short Markdown file Kames
 * reads after every mining cycle, plus the one-paragraph summary line
 * the `mine` command prints to stdout.
 *
 * The report is written in Indonesian, the language Kames reads, and
 * stays factual: only numbers the cycle actually produced, taken from
 * the cycle summary (which itself reads submissions, refusals, and
 * rewards from the memory store, the source of truth). Market and
 * draft ids, verdicts, and refusal reasons stay in their original
 * form so they can be traced back to the store and the trace file.
 *
 * The report lives at `<data-dir>/reports/<cycle-id>.md`.
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import type { MarketSkipReason } from "./picking.js";
import type { CycleCostRecord } from "./costs.js";
import type {
  ReceiptVerdict,
  RefusalReason,
} from "../submit/types.js";
import {
  assertValidCycleId,
  formatUsdc,
  writeFileAtomic,
} from "../util.js";

/** One draft the cycle created, with its review score. */
export interface CycleDraftInfo {
  /** Id of the market the draft is evidence for. */
  marketId: string;
  /** Id of the draft. */
  draftId: string;
  /** Overall self-review score, when the draft was reviewed. */
  reviewScore?: number;
  /** Whether the draft passed self-review. */
  reviewPassed?: boolean;
}

/** One submission the cycle sent, with its receipt verdict. */
export interface CycleSubmissionInfo {
  /** Id of the market the evidence is for. */
  marketId: string;
  /** Id of the draft that was submitted. */
  draftId: string;
  /** Id Delphi assigned to the submission. */
  submissionId: string;
  /** What Delphi decided about the submission. */
  verdict: ReceiptVerdict;
}

/** One submission attempt the cycle refused before sending. */
export interface CycleRefusalInfo {
  /** Id of the market the draft is for. */
  marketId: string;
  /** Id of the draft that was refused. */
  draftId: string;
  /** Why the attempt was refused. */
  reason: RefusalReason;
}

/**
 * Everything one mining cycle produced, in one object. The runner
 * builds it; the report formats it; `--json` prints it. Ticket 09
 * reads it to decide what the next scheduled cycle should do.
 */
export interface CycleSummary {
  /** Id of the mining cycle (`cycle-<ISO timestamp>`). */
  cycleId: string;
  /** ISO timestamp when the cycle started. */
  startedAt: string;
  /** ISO timestamp when the cycle finished (or was interrupted). */
  finishedAt: string;
  /** True when the cycle drafted without submitting anything. */
  dryRun: boolean;
  /** `completed` when the cycle ran to the end, `interrupted` when it stopped early. */
  status: "completed" | "interrupted";
  /** True when the cycle stopped drafting because the model-call budget ran out. */
  budgetExhausted: boolean;
  /** True when the cycle stopped picking new markets because the time budget ran out. */
  timeBudgetExhausted: boolean;
  /** Ids of the markets the sync checked. */
  marketsChecked: string[];
  /** Ids of the markets the cycle picked as targets. */
  marketsPicked: string[];
  /** Markets the cycle skipped, with the reason for each. */
  marketsSkipped: Array<{ marketId: string; reason: MarketSkipReason }>;
  /** Drafts the cycle created, with their review scores. */
  drafts: CycleDraftInfo[];
  /** Submissions the cycle sent, with their receipt verdicts. */
  submissions: CycleSubmissionInfo[];
  /** Submission attempts the cycle refused. */
  refusals: CycleRefusalInfo[];
  /** Total rewards recorded so far, across all cycles, in USDC. */
  rewardsSoFar: { judgment: number; settlement: number; total: number };
  /** What the cycle cost, in calls and credits. */
  cost: CycleCostRecord;
  /** Errors the cycle recorded (per-market failures and interruptions). */
  errors: string[];
  /** Path of this report file. */
  reportPath: string;
  /** Path of the cycle's JSONL trace file. */
  tracePath: string;
  /** Path of the cycle's cost record. */
  costPath: string;
}

/** Path of the report file for one cycle. */
export function cycleReportPath(dataDir: string, cycleId: string): string {
  assertValidCycleId(cycleId);
  return join(dataDir, "reports", `${cycleId}.md`);
}

function formatSkipReason(reason: MarketSkipReason): string {
  switch (reason) {
    case "not-open":
      return "pasar tidak lagi open";
    case "fully-covered":
      return "sudah 3 submission (batas per pasar)";
    case "past-cutoff":
      return "batas waktu bukti sudah lewat";
    case "over-cap":
      return "di luar batas pasar per siklus";
  }
}

function formatVerdictLine(submission: CycleSubmissionInfo): string {
  return `- ${submission.marketId} — submission ${submission.submissionId} (draf ${submission.draftId}), verdict ${submission.verdict}`;
}

function formatDraftLine(draft: CycleDraftInfo): string {
  const score =
    draft.reviewScore === undefined
      ? "tanpa skor"
      : `skor ${draft.reviewScore.toFixed(2)}` +
        (draft.reviewPassed === undefined
          ? ""
          : draft.reviewPassed
            ? " (lolos)"
            : " (ditolak)");
  return `- ${draft.marketId} — draf ${draft.draftId}, ${score}`;
}

/**
 * Format one cycle's summary as a short Markdown report. Only
 * numbers the cycle actually produced appear here; an empty cycle
 * reports zeros, not guesses.
 */
export function formatCycleReport(summary: CycleSummary): string {
  const lines: string[] = [
    `# Laporan siklus mining — ${summary.cycleId}`,
    "",
    `- Mulai: ${summary.startedAt}`,
    `- Selesai: ${summary.finishedAt}`,
    `- Status: ${summary.status === "completed" ? "selesai" : "terganggu"}`,
    `- Mode: ${summary.dryRun ? "dry-run (tidak ada submission)" : "live"}`,
  ];
  if (summary.budgetExhausted) {
    lines.push(
      "- Anggaran panggilan model habis: siklus berhenti membuat draf baru.",
    );
  }
  if (summary.timeBudgetExhausted) {
    lines.push(
      "- Batas waktu siklus habis: siklus berhenti memilih pasar baru.",
    );
  }
  lines.push(
    "",
    `## Pasar diperiksa (${summary.marketsChecked.length})`,
    "",
  );
  if (summary.marketsChecked.length === 0) {
    lines.push("Tidak ada pasar yang diperiksa.");
  } else {
    for (const marketId of summary.marketsChecked) {
      const picked = summary.marketsPicked.includes(marketId);
      lines.push(`- ${marketId}${picked ? " (dipilih)" : ""}`);
    }
  }
  if (summary.marketsSkipped.length > 0) {
    lines.push("", "Pasar yang dilewati:");
    for (const skipped of summary.marketsSkipped) {
      lines.push(
        `- ${skipped.marketId} — ${formatSkipReason(skipped.reason)}`,
      );
    }
  }
  lines.push("", `## Draf (${summary.drafts.length})`, "");
  if (summary.drafts.length === 0) {
    lines.push("Tidak ada draf baru.");
  } else {
    for (const draft of summary.drafts) {
      lines.push(formatDraftLine(draft));
    }
  }
  lines.push("", `## Submission (${summary.submissions.length})`, "");
  if (summary.submissions.length === 0) {
    lines.push("Tidak ada submission.");
  } else {
    for (const submission of summary.submissions) {
      lines.push(formatVerdictLine(submission));
    }
  }
  lines.push("", `## Penolakan (${summary.refusals.length})`, "");
  if (summary.refusals.length === 0) {
    lines.push("Tidak ada penolakan.");
  } else {
    for (const refusal of summary.refusals) {
      lines.push(
        `- ${refusal.marketId} — draf ${refusal.draftId}, alasan: ${refusal.reason}`,
      );
    }
  }
  lines.push(
    "",
    "## Reward sejauh ini",
    "",
    `- Judgment: ${formatUsdc(summary.rewardsSoFar.judgment)}`,
    `- Settlement: ${formatUsdc(summary.rewardsSoFar.settlement)}`,
    `- Total: ${formatUsdc(summary.rewardsSoFar.total)}`,
    // TODO(ticket 08): rank/leaderboard context needs the Delphi
    // leaderboard endpoint, unknown until the guide publishes.
    `- Peringkat/leaderboard: belum tersedia sampai panduan Delphi terbit (ticket 08).`,
    "",
    "## Biaya",
    "",
    `- Panggilan model: ${summary.cost.modelCalls}`,
    `- Panggilan search: ${summary.cost.searchCalls}`,
    `- Kredit search: ${summary.cost.searchCreditsUsed}`,
    "",
    "## Error",
    "",
  );
  if (summary.errors.length === 0) {
    lines.push("Tidak ada error.");
  } else {
    for (const error of summary.errors) {
      lines.push(`- ${error}`);
    }
  }
  lines.push(
    "",
    `Trace: ${summary.tracePath}`,
    `Biaya: ${summary.costPath}`,
    "",
  );
  return lines.join("\n");
}

/**
 * One-paragraph summary of a cycle, printed to stdout by the `mine`
 * command. Counts only, no ids beyond the cycle itself.
 */
export function formatCycleSummaryLine(summary: CycleSummary): string {
  const accepted = summary.submissions.filter(
    (submission) => submission.verdict === "accepted",
  ).length;
  const judged = summary.submissions.filter(
    (submission) => submission.verdict === "judged",
  ).length;
  const rejected = summary.submissions.filter(
    (submission) => submission.verdict === "rejected",
  ).length;
  const parts = [
    `Siklus ${summary.cycleId} ${summary.status === "completed" ? "selesai" : "terganggu"}`,
    `${summary.marketsChecked.length} pasar diperiksa`,
    `${summary.drafts.length} draf`,
    `${summary.submissions.length} submission` +
      (summary.submissions.length > 0
        ? ` (${accepted} diterima, ${judged} dinilai, ${rejected} ditolak)`
        : ""),
    `${summary.refusals.length} penolakan`,
    `reward sejauh ini ${formatUsdc(summary.rewardsSoFar.total)}`,
  ];
  if (summary.dryRun) {
    parts.push("dry-run: tidak ada submission yang dikirim");
  }
  if (summary.budgetExhausted) {
    parts.push("anggaran panggilan model habis");
  }
  if (summary.timeBudgetExhausted) {
    parts.push("batas waktu siklus habis");
  }
  parts.push(
    `biaya ${summary.cost.modelCalls} panggilan model, ${summary.cost.searchCalls} panggilan search`,
    `laporan: ${summary.reportPath}`,
  );
  return `${parts.join("; ")}.`;
}

/**
 * Write one cycle's report to `<data-dir>/reports/<cycle-id>.md`.
 * Creates the reports directory when it is missing. Returns the path
 * written.
 */
export async function writeCycleReport(
  dataDir: string,
  summary: CycleSummary,
): Promise<string> {
  const path = cycleReportPath(dataDir, summary.cycleId);
  await mkdir(join(dataDir, "reports"), { recursive: true });
  await writeFileAtomic(path, formatCycleReport(summary));
  return path;
}
