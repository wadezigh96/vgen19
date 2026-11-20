/**
 * The `draft` command: draft evidence for one market and self-review
 * it, without ever submitting.
 *
 * The command loads the market's stored research notes and runs the
 * research loop first when none exist (reusing `researchMarket`
 * through the draft pipeline). It then drafts, reviews, saves, and
 * prints the draft with its per-dimension scores and pass/fail.
 *
 * This command NEVER submits: no submitter is passed to the pipeline,
 * whatever the configuration says. `--dry-run` (and `VGEN19_DRY_RUN`)
 * is accepted and reported for consistency with the mining cycle.
 * Human-readable output by default; `--json` prints the draft as JSON.
 *
 * Exit 0 on success, including a rejected draft (rejection is a
 * normal outcome, not an error) and no draft when the research found
 * nothing. Exit non-zero only on operational failure (unknown market,
 * missing keys, model or validation failure).
 */

import type { CliCommand, CliOutput } from "../cli.js";
import { loadProcessConfig } from "../config.js";
import {
  runDraftPipeline,
  type DraftPipelineDeps,
  type DraftPipelineResult,
} from "../draft/index.js";
import type { RubricDimension } from "../draft/index.js";
import { createRoutedClient } from "../llm/client.js";
import { MemoryStore } from "../memory/store.js";
import { createPageReader } from "../research/index.js";
import { buildSearchProvider } from "../search/index.js";
import { errorMessage, readPositionalArg } from "../util.js";

export interface DraftCommandOverrides {
  /**
   * Fully built pipeline dependencies, for tests. When provided, no
   * live provider is constructed and no key is needed. A submitter
   * carried here is ignored: this command never submits.
   */
  pipelineDeps?: Omit<DraftPipelineDeps, "market">;
}

/** Rubric dimensions in the order the report prints them. */
const DIMENSION_ORDER: RubricDimension[] = [
  "sourced",
  "dated",
  "novel",
  "relevant",
  "noInventedFacts",
];

function formatDraft(
  result: Extract<DraftPipelineResult, { outcome: "drafted" }>,
  dryRun: boolean,
): string {
  const { draft, notes } = result;
  const score = draft.score;
  const lines = [
    `Draft for ${notes.question}`,
    `Market: ${draft.marketId} | Draft: ${draft.id} | Created: ${draft.createdAt}`,
  ];
  if (score !== undefined) {
    lines.push(
      `Status: ${draft.status.toUpperCase()} - overall ${score.overall.toFixed(2)} ` +
        `(threshold ${score.threshold}) - ${score.passed ? "PASS" : "FAIL"}`,
    );
    if (!score.passed) {
      lines.push("Rejected drafts are kept in memory and never sent.");
    }
  } else {
    lines.push(`Status: ${draft.status.toUpperCase()}`);
  }
  if (dryRun) {
    lines.push("Dry run: this draft will not be submitted (dry-run mode).");
  }
  lines.push("", "Note:", draft.note, "", "Links:");
  for (const link of draft.links) {
    lines.push(
      `- ${link.url}${link.title !== undefined ? ` (${link.title})` : ""}`,
    );
  }
  if (score !== undefined) {
    lines.push("", "Self-review:");
    for (const dimension of DIMENSION_ORDER) {
      const entry = score.dimensions[dimension];
      lines.push(
        `  ${dimension}: ${entry.score.toFixed(2)} - ${entry.rationale}`,
      );
    }
  }
  lines.push("");
  return lines.join("\n");
}

export function createDraftCommand(
  overrides: DraftCommandOverrides = {},
): CliCommand {
  return {
    description: "Draft and self-review evidence for one market.",
    name: "draft",
    async run(args, output: CliOutput) {
      // The draft command takes no value flags, so no flag value can
      // be mistaken for the market id; the shared scanner keeps the
      // parsing consistent with the other commands.
      const marketId = readPositionalArg(args, []);
      if (marketId === undefined) {
        output.writeErr(
          "Usage: vgen19 draft <market-id> [--dry-run] [--json]\n" +
            "Run `vgen19 markets` first to see the market ids.\n",
        );
        return 1;
      }

      try {
        const config = loadProcessConfig();
        const store =
          overrides.pipelineDeps?.store ?? new MemoryStore(config.dataDir);
        const markets = await store.loadMarkets();
        const market = markets.find((candidate) => candidate.id === marketId);
        if (market === undefined) {
          output.writeErr(
            `Unknown market: ${marketId}. ` +
              "Run `vgen19 markets` first to sync the market list.\n",
          );
          return 1;
        }

        const notes =
          overrides.pipelineDeps?.notes ??
          (await store.loadResearchNotes(marketId));

        let deps: Omit<DraftPipelineDeps, "market">;
        if (overrides.pipelineDeps !== undefined) {
          deps = overrides.pipelineDeps;
        } else {
          const hasModelKey =
            config.geminiApiKey !== undefined ||
            config.openrouterApiKey !== undefined;
          if (notes === undefined) {
            if (config.tavilyApiKey === undefined && !hasModelKey) {
              throw new Error(
                "Cannot draft: TAVILY_API_KEY and the model key " +
                  "(GEMINI_API_KEY or OPENROUTER_API_KEY) are both missing. " +
                  "Set at least the model key to draft with keyless " +
                  "search, or set both keys (see .env.example).",
              );
            }
            const { keylessOnly, provider } = buildSearchProvider(config);
            if (keylessOnly) {
              output.writeOut(
                "No TAVILY_API_KEY set; using keyless search (rate-limited).\n",
              );
            }
            deps = {
              model: createRoutedClient(config),
              readPage: createPageReader(),
              researcherLimits: {
                maxModelCalls: config.maxModelCallsPerMarket,
                maxPages: config.maxPagesPerMarket,
                maxSearches: config.maxSearchesPerMarket,
                notesCharBudget: config.notesCharBudget,
              },
              search: provider,
              store,
            };
          } else {
            if (!hasModelKey) {
              throw new Error(
                "Cannot draft: the model key (GEMINI_API_KEY or " +
                  "OPENROUTER_API_KEY) is missing. Set it before drafting " +
                  "(see .env.example).",
              );
            }
            deps = {
              model: createRoutedClient(config),
              store,
            };
          }
        }

        const dryRun =
          args.includes("--dry-run") ||
          deps.dryRun === true ||
          config.dryRun;
        const result = await runDraftPipeline({
          ...deps,
          dryRun,
          market,
          notes,
          passThreshold: deps.passThreshold ?? config.reviewPassThreshold,
          // The draft command never submits: no submitter is passed,
          // whatever the overrides carried.
          submit: undefined,
        });

        if (result.outcome === "no-draft") {
          if (args.includes("--json")) {
            output.writeOut(
              `${JSON.stringify(
                { marketId, outcome: "no-draft", reason: result.reason },
                null,
                2,
              )}\n`,
            );
          } else {
            output.writeOut(
              `No draft for market ${marketId}: ${result.reason}\n`,
            );
          }
          return 0;
        }

        if (args.includes("--json")) {
          output.writeOut(`${JSON.stringify(result.draft, null, 2)}\n`);
        } else {
          output.writeOut(formatDraft(result, dryRun));
        }
        return 0;
      } catch (error) {
        output.writeErr(`draft failed: ${errorMessage(error)}\n`);
        return 1;
      }
    },
  };
}

/** The `draft` command with live providers, as registered in the CLI. */
export const draftCommand: CliCommand = createDraftCommand();
