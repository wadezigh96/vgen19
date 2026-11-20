/**
 * The `markets` command: sync the competition market list through the
 * Delphi adapter into the memory store, then show the stored markets.
 *
 * Human-readable table by default; `--json` prints the stored markets
 * as JSON for machine-readable use (later tickets, debugging).
 */

import type { CliCommand } from "../cli.js";
import { loadProcessConfig } from "../config.js";
import { createDelphiAdapter } from "../delphi/index.js";
import { syncMarkets } from "../delphi/sync.js";
import { marketCloseTime, type Market } from "../delphi/types.js";
import { MemoryStore } from "../memory/store.js";
import { errorMessage } from "../util.js";

function formatPercent(odds: number | undefined): string {
  return odds === undefined ? "n/a" : `${Math.round(odds * 100)}%`;
}

function formatMarket(market: Market): string {
  const question =
    market.metadata?.question ?? market.metadata?.title ?? market.id;
  const competition = market.competition;
  const closeTime = marketCloseTime(market) ?? "n/a";
  const cutoff = competition?.evidenceCutoff ?? "n/a";
  const pot =
    competition?.rewardPot === undefined
      ? "n/a"
      : `${competition.rewardPot} USDC.e`;
  return [
    `- ${question}`,
    `  Yes ${formatPercent(competition?.oddsYes)} / No ${formatPercent(competition?.oddsNo)}` +
      `  |  Closes ${closeTime}` +
      `  |  Cutoff ${cutoff}` +
      `  |  Pot ${pot}` +
      `  |  ${market.status}`,
  ].join("\n");
}

export const marketsCommand: CliCommand = {
  description: "Sync and list the competition markets.",
  name: "markets",
  async run(args, output) {
    try {
      const config = loadProcessConfig();
      const adapter = createDelphiAdapter();
      const store = new MemoryStore(config.dataDir);

      const result = await syncMarkets(adapter, store);
      const markets = await store.loadMarkets();

      if (args.includes("--json")) {
        output.writeOut(`${JSON.stringify(markets, null, 2)}\n`);
        return 0;
      }

      const lines = [
        `Markets synced from Delphi: ${markets.length} stored` +
          ` (${result.added} new, ${result.updated} updated).`,
        "",
        ...markets.map(formatMarket),
        "",
      ];
      output.writeOut(lines.join("\n"));
      return 0;
    } catch (error) {
      output.writeErr(`markets failed: ${errorMessage(error)}\n`);
      return 1;
    }
  },
};
