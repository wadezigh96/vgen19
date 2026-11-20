/**
 * The `mine` command: run one complete mining cycle (sync markets,
 * pick targets, research, draft, submit, read receipts, report).
 *
 * `mine [--cycle <id>] [--dry-run] [--json]`
 *
 * - `--cycle <id>` runs the cycle under a given id (the report,
 *   trace, and cost record all carry it). Without it, the cycle id
 *   is `cycle-<ISO timestamp>`.
 * - `--dry-run` (or `VGEN19_DRY_RUN`) drafts evidence without
 *   submitting anything.
 * - `--json` prints the cycle summary as JSON instead of the
 *   one-paragraph summary.
 *
 * Exit 0 on a completed cycle, including an empty one (zero drafts
 * and zero submissions is a normal outcome, not a failure). Exit
 * non-zero only on operational failure (adapter unreachable, missing
 * keys when live providers are configured).
 */

import type { CliCommand, CliOutput } from "../cli.js";
import {
  loadProcessConfig,
  primaryStrongModel,
  type Vgen19Config,
} from "../config.js";
import { runCycle, type CycleDeps } from "../cycle/runner.js";
import { formatCycleSummaryLine } from "../cycle/report.js";
import { createDelphiAdapter } from "../delphi/index.js";
import { createRoutedClient } from "../llm/client.js";
import { MemoryStore } from "../memory/store.js";
import { createPageReader } from "../research/index.js";
import { buildSearchProvider } from "../search/index.js";
import {
  assertValidCycleId,
  errorMessage,
  readOption,
} from "../util.js";

export interface MineCommandOverrides {
  /** Config, for tests. Defaults to the process environment. */
  config?: Vgen19Config;
  /**
   * Fully built cycle dependencies, for tests. When provided, no
   * live provider is constructed and no key is needed. The `--cycle`
   * and `--dry-run` flags still override the matching fields.
   */
  cycleDeps?: CycleDeps;
}

export function createMineCommand(
  overrides: MineCommandOverrides = {},
): CliCommand {
  return {
    description: "Run one full mining cycle and write its report.",
    name: "mine",
    async run(args, output: CliOutput) {
      try {
        const config = overrides.config ?? loadProcessConfig();
        const cycleId = readOption(args, "--cycle");
        // Validate early: the cycle id is interpolated into file
        // paths, so a traversal id must fail here, before any work.
        if (cycleId !== undefined) {
          assertValidCycleId(cycleId);
        }
        const dryRun = args.includes("--dry-run") || config.dryRun;

        let deps: CycleDeps;
        if (overrides.cycleDeps !== undefined) {
          deps = {
            ...overrides.cycleDeps,
            ...(cycleId !== undefined ? { cycleId } : {}),
            dryRun:
              dryRun || overrides.cycleDeps.dryRun === true,
          };
        } else {
          const hasModelKey =
            config.geminiApiKey !== undefined ||
            config.openrouterApiKey !== undefined;
          if (!hasModelKey) {
            throw new Error(
              "Cannot mine: the model key (GEMINI_API_KEY or " +
                "OPENROUTER_API_KEY) is missing. Set it before mining " +
                "(see .env.example).",
            );
          }
          const { keylessOnly, provider } = buildSearchProvider(config);
          if (keylessOnly) {
            output.writeOut(
              "No TAVILY_API_KEY set; using keyless search (rate-limited).\n",
            );
          }
          const store = new MemoryStore(config.dataDir);
          deps = {
            adapter: createDelphiAdapter(),
            approvalGate: config.approvalGate,
            cycleId,
            cycleTimeBudgetMinutes: config.cycleTimeBudgetMinutes,
            dataDir: config.dataDir,
            dryRun,
            maxMarketsPerCycle: config.maxMarketsPerCycle,
            maxSubmissionsPerCycle: config.maxSubmissionsPerCycle,
            model: createRoutedClient(config),
            passThreshold: config.reviewPassThreshold,
            readPage: createPageReader(),
            researcherLimits: {
              maxModelCalls: config.maxModelCallsPerMarket,
              maxPages: config.maxPagesPerMarket,
              maxSearches: config.maxSearchesPerMarket,
              notesCharBudget: config.notesCharBudget,
            },
            search: provider,
            store,
            submissionModel: primaryStrongModel(config),
            warn: (message: string) => output.writeErr(`${message}\n`),
          };
        }

        const summary = await runCycle(deps);
        if (args.includes("--json")) {
          output.writeOut(`${JSON.stringify(summary, null, 2)}\n`);
        } else {
          output.writeOut(`${formatCycleSummaryLine(summary)}\n`);
        }
        return 0;
      } catch (error) {
        output.writeErr(`mine failed: ${errorMessage(error)}\n`);
        return 1;
      }
    },
  };
}

/** The `mine` command with live providers, as registered in the CLI. */
export const mineCommand: CliCommand = createMineCommand();
