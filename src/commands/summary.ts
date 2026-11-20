/**
 * The `summary` command: aggregate the end-of-competition final
 * summary (spec story 31) and write it to
 * `<data-dir>/final-summary.md`.
 *
 * `summary [--json]`
 *
 * - Without flags, prints a one-paragraph summary to stdout.
 * - `--json` prints the aggregated data as JSON instead (the report
 *   file is still written).
 *
 * The command takes no arguments and reads only: it aggregates what
 * the mining cycles already recorded (memory store, cost records,
 * traces, run index). Exit 0 on success, non-zero on failure.
 */

import type { CliCommand, CliOutput } from "../cli.js";
import { loadProcessConfig, type Vgen19Config } from "../config.js";
import { aggregateFinalSummary } from "../summary/aggregate.js";
import {
  formatFinalSummaryLine,
  writeFinalSummary,
} from "../summary/report.js";
import { errorMessage } from "../util.js";

export interface SummaryCommandOverrides {
  /** Config, for tests. Defaults to the process environment. */
  config?: Vgen19Config;
}

export function createSummaryCommand(
  overrides: SummaryCommandOverrides = {},
): CliCommand {
  return {
    description:
      "Aggregate the end-of-competition final summary and write its report.",
    name: "summary",
    async run(args, output: CliOutput) {
      try {
        const config = overrides.config ?? loadProcessConfig();
        const summary = await aggregateFinalSummary(config.dataDir);
        const path = await writeFinalSummary(config.dataDir, summary);
        if (args.includes("--json")) {
          output.writeOut(`${JSON.stringify(summary, null, 2)}\n`);
        } else {
          output.writeOut(`${formatFinalSummaryLine(summary, path)}\n`);
        }
        return 0;
      } catch (error) {
        output.writeErr(`summary failed: ${errorMessage(error)}\n`);
        return 1;
      }
    },
  };
}

/** The `summary` command with live config, as registered in the CLI. */
export const summaryCommand: CliCommand = createSummaryCommand();
