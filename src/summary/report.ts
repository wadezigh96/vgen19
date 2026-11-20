/**
 * The final summary report (spec story 31): a Markdown file Kames
 * reads when the competition window closes, plus the one-paragraph
 * summary line the `summary` command prints to stdout.
 *
 * The report is written in Indonesian, the language Kames reads,
 * like the per-cycle reports. Only numbers the cycles actually
 * produced appear here; a count the data cannot describe renders as
 * `n/a`, never as a guessed zero.
 *
 * The report lives at `<data-dir>/final-summary.md`.
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import type {
  BestEvidenceEntry,
  FailedCycleEntry,
  FinalSummary,
  FinalSummaryCycleRow,
  FinalSummaryMarketRow,
} from "./types.js";
import { formatUsdc, writeFileAtomic } from "../util.js";

/** Path of the final summary report file. */
export function finalSummaryPath(dataDir: string): string {
  return join(dataDir, "final-summary.md");
}

function formatStatus(status: FinalSummaryCycleRow["status"]): string {
  switch (status) {
    case "ok":
      return "selesai";
    case "failed":
      return "gagal";
    case "unknown":
      return "tidak diketahui";
  }
}

function formatCount(value: number | null): string {
  return value === null ? "n/a" : String(value);
}

function formatMarketLine(row: FinalSummaryMarketRow): string {
  return (
    `- ${row.question} — ${row.submissions} submission, ` +
    `reward ${formatUsdc(row.judgmentReward + row.settlementReward)} ` +
    `(judgment ${formatUsdc(row.judgmentReward)}, ` +
    `settlement ${formatUsdc(row.settlementReward)})`
  );
}

function formatBestEvidenceLines(
  entry: BestEvidenceEntry,
  rank: number,
): string[] {
  const lines = [
    `${rank}. ${entry.question} — submission ${entry.submissionId}, ` +
      `judgment ${formatUsdc(entry.judgmentReward)}` +
      (entry.settlementReward > 0
        ? `, settlement ${formatUsdc(entry.settlementReward)}`
        : ""),
  ];
  if (entry.noteExcerpt !== "") {
    lines.push(`   > ${entry.noteExcerpt}`);
  }
  for (const link of entry.links) {
    lines.push(`   - ${link}`);
  }
  return lines;
}

function formatCycleRow(row: FinalSummaryCycleRow): string {
  return (
    `| ${row.cycleId} | ${formatStatus(row.status)} | ${row.markets} | ` +
    `${formatCount(row.drafts)} | ${row.submissions} | ` +
    `${formatUsdc(row.judgmentReward + row.settlementReward)} | ` +
    `${formatCount(row.modelCalls)} | ${formatCount(row.searchCalls)} |`
  );
}

function formatFailureLine(entry: FailedCycleEntry): string {
  const kind = entry.kind === "failed" ? "gagal" : "tidak diketahui";
  const log =
    entry.logPath !== undefined ? ` (log: ${entry.logPath})` : "";
  return `- ${entry.cycleId} — ${kind}: ${entry.reason}${log}`;
}

/**
 * Format the aggregated final summary as a Markdown report. Only
 * numbers the cycles actually produced appear here; an empty
 * competition reports zeros and empty sections, not guesses.
 */
export function formatFinalSummary(summary: FinalSummary): string {
  const totals = summary.totals;
  const lines: string[] = [
    "# Ringkasan akhir kompetisi — Vgen19",
    "",
    `- Dibuat: ${summary.generatedAt}`,
    `- Siklus: ${totals.cycles} (${totals.failedCycles} gagal/tidak diketahui)`,
    "",
    "## Total",
    "",
    `- ${totals.submissions} submission ` +
      `(${totals.accepted} diterima, ${totals.judged} dinilai, ${totals.rejected} ditolak)`,
    `- ${totals.marketsCovered} pasar tercakup`,
    `- Reward judgment: ${formatUsdc(totals.judgmentReward)}`,
    `- Reward settlement: ${formatUsdc(totals.settlementReward)}`,
    `- Total reward: ${formatUsdc(totals.totalReward)}`,
    // TODO(ticket 08): rank/leaderboard context needs the Delphi
    // leaderboard endpoint, unknown until the guide publishes.
    `- Peringkat/leaderboard: belum tersedia sampai panduan Delphi terbit (ticket 08).`,
    `- Panggilan model: ${totals.modelCalls}`,
    `- Panggilan search: ${totals.searchCalls}`,
    `- Kredit search: ${totals.searchCreditsUsed}`,
    "",
    `## Pasar (${summary.markets.length})`,
    "",
  ];
  if (summary.markets.length === 0) {
    lines.push("Tidak ada pasar yang tercakup.");
  } else {
    for (const row of summary.markets) {
      lines.push(formatMarketLine(row));
    }
  }
  lines.push("", `## Bukti terbaik (${summary.bestEvidence.length})`, "");
  if (summary.bestEvidence.length === 0) {
    lines.push("Belum ada bukti yang mendapat reward judgment.");
  } else {
    summary.bestEvidence.forEach((entry, index) => {
      lines.push(...formatBestEvidenceLines(entry, index + 1));
    });
  }
  lines.push("", `## Siklus (${summary.cycles.length})`, "");
  if (summary.cycles.length === 0) {
    lines.push("Tidak ada siklus yang tercatat.");
  } else {
    lines.push(
      "| Siklus | Status | Pasar | Draf | Submission | Reward | Panggilan model | Panggilan search |",
      "| ------ | ------ | ----- | ---- | ---------- | ------ | --------------- | ---------------- |",
    );
    for (const row of summary.cycles) {
      lines.push(formatCycleRow(row));
    }
  }
  lines.push("", `## Kegagalan (${summary.failures.length})`, "");
  if (summary.failures.length === 0) {
    lines.push("Tidak ada kegagalan.");
  } else {
    for (const entry of summary.failures) {
      lines.push(formatFailureLine(entry));
    }
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * One-paragraph summary, printed to stdout by the `summary`
 * command. Counts and the best submission only; the report path is
 * appended when given.
 */
export function formatFinalSummaryLine(
  summary: FinalSummary,
  summaryPath?: string,
): string {
  const totals = summary.totals;
  const parts = [
    `Ringkasan akhir: ${totals.submissions} submission di ${totals.marketsCovered} pasar` +
      ` (${totals.accepted} diterima, ${totals.judged} dinilai, ${totals.rejected} ditolak)`,
    `total reward ${formatUsdc(totals.totalReward)}`,
    `${totals.cycles} siklus (${totals.failedCycles} gagal/tidak diketahui)`,
  ];
  const best = summary.bestEvidence[0];
  if (best !== undefined) {
    parts.push(
      `bukti terbaik: ${best.submissionId} (${formatUsdc(best.judgmentReward)})`,
    );
  }
  if (summaryPath !== undefined) {
    parts.push(`laporan: ${summaryPath}`);
  }
  return `${parts.join("; ")}.`;
}

/**
 * Write the final summary report to `<data-dir>/final-summary.md`.
 * Returns the path written.
 */
export async function writeFinalSummary(
  dataDir: string,
  summary: FinalSummary,
): Promise<string> {
  const path = finalSummaryPath(dataDir);
  await mkdir(dataDir, { recursive: true });
  await writeFileAtomic(path, formatFinalSummary(summary));
  return path;
}
