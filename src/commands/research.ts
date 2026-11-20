/**
 * The `research` command: research one market from the memory store
 * and save the notes.
 *
 * The market must already be stored (run `vgen19 markets` first); an
 * unknown market id fails with a clear message instead of syncing
 * silently. Live providers are built from config: keyed Tavily with
 * the keyless fallback when `TAVILY_API_KEY` is set, keyless-only
 * search otherwise, and the routed model client for extraction.
 * When the search key and the model key are both missing, the command
 * fails closed with a message naming both variables.
 *
 * Human-readable notes by default; `--json` prints the notes as JSON
 * for machine-readable use (later tickets, debugging).
 */

import type { CliCommand, CliOutput } from "../cli.js";
import { loadProcessConfig } from "../config.js";
import { createRoutedClient } from "../llm/client.js";
import { MemoryStore } from "../memory/store.js";
import {
  createPageReader,
  researchMarket,
  type ResearcherDeps,
  type ResearchNotes,
} from "../research/index.js";
import { buildSearchProvider } from "../search/index.js";
import { errorMessage, readPositionalArg } from "../util.js";

export interface ResearchCommandOverrides {
  /**
   * Fully built researcher dependencies, for tests. When provided,
   * no live provider is constructed and no key is needed.
   */
  researcherDeps?: ResearcherDeps;
}

function formatNotes(notes: ResearchNotes): string {
  const lines = [
    `Research notes for ${notes.question}`,
    `Market: ${notes.marketId} | Fetched: ${notes.fetchedAt}` +
      ` | Compacted: ${notes.compacted ? "yes" : "no"}`,
    "",
    `Findings (${notes.findings.length}):`,
  ];
  if (notes.findings.length === 0) {
    lines.push("  (none: no new facts found for this market)");
  }
  for (const finding of notes.findings) {
    lines.push(`- ${finding.claim} (${finding.date})`);
    lines.push(`  Source: ${finding.sourceUrl}`);
  }
  if (notes.failedSources.length > 0) {
    lines.push("", `Failed sources (${notes.failedSources.length}):`);
    for (const failed of notes.failedSources) {
      lines.push(`- ${failed.url}: ${failed.reason}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

export function createResearchCommand(
  overrides: ResearchCommandOverrides = {},
): CliCommand {
  return {
    description: "Research one market and save its notes.",
    name: "research",
    async run(args, output: CliOutput) {
      // The research command takes no value flags, so no flag value
      // can be mistaken for the market id; the shared scanner keeps
      // the parsing consistent with the other commands.
      const marketId = readPositionalArg(args, []);
      if (marketId === undefined) {
        output.writeErr(
          "Usage: vgen19 research <market-id>\n" +
            "Run `vgen19 markets` first to see the market ids.\n",
        );
        return 1;
      }

      try {
        const config = loadProcessConfig();
        const store =
          overrides.researcherDeps?.store ??
          new MemoryStore(config.dataDir);
        const markets = await store.loadMarkets();
        const market = markets.find((candidate) => candidate.id === marketId);
        if (market === undefined) {
          output.writeErr(
            `Unknown market: ${marketId}. ` +
              "Run `vgen19 markets` first to sync the market list.\n",
          );
          return 1;
        }

        let deps: ResearcherDeps;
        if (overrides.researcherDeps !== undefined) {
          deps = overrides.researcherDeps;
        } else {
          const hasModelKey =
            config.geminiApiKey !== undefined ||
            config.openrouterApiKey !== undefined;
          if (config.tavilyApiKey === undefined && !hasModelKey) {
            throw new Error(
              "Cannot research: TAVILY_API_KEY and the model key " +
                "(GEMINI_API_KEY or OPENROUTER_API_KEY) are both missing. " +
                "Set at least the model key to research with keyless " +
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
            limits: {
              maxModelCalls: config.maxModelCallsPerMarket,
              maxPages: config.maxPagesPerMarket,
              maxSearches: config.maxSearchesPerMarket,
              notesCharBudget: config.notesCharBudget,
            },
            model: createRoutedClient(config),
            readPage: createPageReader(),
            search: provider,
            store,
          };
        }

        const notes = await researchMarket(market, deps);
        await store.saveResearchNotes(notes);

        if (args.includes("--json")) {
          output.writeOut(`${JSON.stringify(notes, null, 2)}\n`);
        } else {
          output.writeOut(formatNotes(notes));
        }
        return 0;
      } catch (error) {
        output.writeErr(`research failed: ${errorMessage(error)}\n`);
        return 1;
      }
    },
  };
}

/** The `research` command with live providers, as registered in the CLI. */
export const researchCommand: CliCommand = createResearchCommand();
