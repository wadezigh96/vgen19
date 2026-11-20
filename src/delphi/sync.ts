/**
 * Market sync: fetch the competition market list through the Delphi
 * adapter and upsert it into the memory store.
 *
 * Syncing is idempotent: re-syncing the same markets changes nothing,
 * and a market whose odds or other fields moved is updated in place
 * instead of being stored twice.
 */

import type { DelphiAdapter } from "./adapter.js";
import type { Market } from "./types.js";
import type { MemoryStore } from "../memory/store.js";

export interface MarketSyncResult {
  /** Markets fetched from Delphi in this sync. */
  markets: Market[];
  /** Markets that were new to the store. */
  added: number;
  /** Stored markets whose fields changed in this sync. */
  updated: number;
}

/** Markets fetched per page while syncing. */
export const SYNC_PAGE_SIZE = 50;

/**
 * Key-order-insensitive deep equality for plain JSON values: two
 * markets are the same market when every field matches, whatever
 * order the API serialized the keys in.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (
    typeof a !== "object" ||
    typeof b !== "object" ||
    a === null ||
    b === null
  ) {
    return false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    return a.every((item, index) => deepEqual(item, b[index]));
  }
  const aRecord = a as Record<string, unknown>;
  const bRecord = b as Record<string, unknown>;
  const aKeys = Object.keys(aRecord);
  const bKeys = Object.keys(bRecord);
  if (aKeys.length !== bKeys.length) {
    return false;
  }
  return aKeys.every(
    (key) =>
      Object.hasOwn(bRecord, key) && deepEqual(aRecord[key], bRecord[key]),
  );
}

function sameMarket(a: Market, b: Market): boolean {
  return deepEqual(a, b);
}

export async function syncMarkets(
  adapter: DelphiAdapter,
  store: MemoryStore,
): Promise<MarketSyncResult> {
  // Page through the list: the API's default page is 50, so a single
  // call would silently cap the sync. Stop on a short page, an empty
  // page, or a page that adds no new market ids — an adapter that
  // ignores skip/limit would otherwise loop forever — and dedupe by
  // id in case pages overlap.
  const markets: Market[] = [];
  const seen = new Set<string>();
  let skip = 0;
  for (;;) {
    const page = await adapter.listMarkets({
      limit: SYNC_PAGE_SIZE,
      skip,
    });
    let newInPage = 0;
    for (const market of page) {
      if (!seen.has(market.id)) {
        seen.add(market.id);
        markets.push(market);
        newInPage += 1;
      }
    }
    if (page.length < SYNC_PAGE_SIZE || newInPage === 0) {
      break;
    }
    skip += page.length;
  }

  const stored = new Map(
    (await store.loadMarkets()).map((market) => [market.id, market]),
  );

  let added = 0;
  let updated = 0;
  for (const market of markets) {
    const previous = stored.get(market.id);
    if (previous === undefined) {
      added += 1;
    } else if (!sameMarket(previous, market)) {
      updated += 1;
    }
  }

  await store.saveMarkets(markets);
  return { added, markets, updated };
}
