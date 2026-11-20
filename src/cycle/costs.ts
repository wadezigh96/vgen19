/**
 * Cost tracking for a mining cycle (spec story 26): how many model
 * calls, search calls, and search credits one cycle used, so Kames
 * can see the competition is really free.
 *
 * Model calls are counted from the routed client's own budget
 * counter (`callsUsed`) when the model exposes it; a bare model
 * without that seam is wrapped in `CountingModelClient` instead.
 * Search calls are counted by wrapping the search provider in
 * `CountingSearchProvider`, which also sums the `usage.credits`
 * the provider reports (Tavily reports 1 credit per basic search;
 * the fake reports 1 too).
 *
 * The record is persisted once per cycle to
 * `<data-dir>/costs/<cycle-id>.json` and included in the report.
 * Never record any key or secret in a cost record.
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import type {
  ChatMessage,
  CompleteOptions,
  JsonSchema,
  TaskKind,
} from "../llm/types.js";
import type {
  SearchOptions,
  SearchProvider,
  SearchResponse,
} from "../search/types.js";
import { writeFileAtomic, assertValidCycleId } from "../util.js";

/**
 * The model seam the cycle runner uses: structured JSON output for a
 * task kind, plus the routed client's budget counter when the model
 * has one. `RoutedModelClient` satisfies this interface.
 */
export interface CycleModel {
  completeJson<T>(
    taskKind: TaskKind,
    messages: ChatMessage[],
    schema: JsonSchema,
    options?: CompleteOptions,
  ): Promise<T>;
  /** Model calls made so far, when the model exposes its counter. */
  readonly callsUsed?: number;
  /** Model calls left in the budget, when the model exposes it. */
  readonly callsRemaining?: number;
  /** The per-cycle model-call budget, when the model exposes it. */
  readonly budget?: number;
}

/** What one mining cycle cost, in calls and credits. */
export interface CycleCostRecord {
  /** Id of the mining cycle. */
  cycleId: string;
  /** Model calls made in this cycle. */
  modelCalls: number;
  /** Search calls made in this cycle. */
  searchCalls: number;
  /** Search credits used in this cycle (0 when unreported). */
  searchCreditsUsed: number;
  /** ISO timestamp when the record was written. */
  recordedAt: string;
}

/** Path of the cost record for one cycle. */
export function cycleCostPath(dataDir: string, cycleId: string): string {
  assertValidCycleId(cycleId);
  return join(dataDir, "costs", `${cycleId}.json`);
}

/**
 * Persist one cycle's cost record. Creates the costs directory when
 * it is missing. Returns the path written.
 */
export async function writeCostRecord(
  dataDir: string,
  record: CycleCostRecord,
): Promise<string> {
  const path = cycleCostPath(dataDir, record.cycleId);
  await mkdir(join(dataDir, "costs"), { recursive: true });
  await writeFileAtomic(path, `${JSON.stringify(record, null, 2)}\n`);
  return path;
}

/**
 * A search provider wrapper that counts calls and credits. Every
 * attempt counts, including failed ones: a failed search still spent
 * the call. Credits are summed from `usage.credits` on the response
 * when the provider reports them, and stay 0 otherwise.
 */
export class CountingSearchProvider implements SearchProvider {
  readonly name: string;
  /** Search calls attempted through this wrapper. */
  searchCalls = 0;
  /** Search credits reported by the provider so far. */
  searchCreditsUsed = 0;
  private readonly inner: SearchProvider;

  constructor(inner: SearchProvider) {
    this.inner = inner;
    this.name = `counting(${inner.name})`;
  }

  async search(
    query: string,
    options?: SearchOptions,
  ): Promise<SearchResponse> {
    this.searchCalls += 1;
    const response = await this.inner.search(query, options);
    const credits = response.usage?.credits;
    if (
      typeof credits === "number" &&
      Number.isFinite(credits) &&
      credits >= 0
    ) {
      this.searchCreditsUsed += credits;
    }
    return response;
  }
}

/**
 * A model wrapper that counts structured-output calls. Used only for
 * models without their own counter; the routed client's `callsUsed`
 * is preferred (see `createModelCallCounter`).
 */
export class CountingModelClient implements CycleModel {
  /** Structured-output calls made through this wrapper. */
  modelCalls = 0;
  private readonly inner: CycleModel;

  constructor(inner: CycleModel) {
    this.inner = inner;
  }

  async completeJson<T>(
    taskKind: TaskKind,
    messages: ChatMessage[],
    schema: JsonSchema,
    options?: CompleteOptions,
  ): Promise<T> {
    this.modelCalls += 1;
    return this.inner.completeJson<T>(taskKind, messages, schema, options);
  }
}

/** A model plus a way to read how many calls it made in this cycle. */
export interface ModelCallCounter {
  /** The model the cycle hands to the pipeline (wrapped when needed). */
  model: CycleModel;
  /** Model calls made since this counter was created. */
  callsUsed(): number;
}

/**
 * Build a call counter for a model. When the model exposes the
 * routed client's `callsUsed` counter, the delta from creation time
 * is the count (a reused client may already have calls behind it).
 * Otherwise the model is wrapped in a `CountingModelClient` and the
 * wrapper's count is used.
 */
export function createModelCallCounter(model: CycleModel): ModelCallCounter {
  const start = model.callsUsed;
  if (typeof start === "number") {
    return {
      callsUsed: () => (model.callsUsed ?? start) - start,
      model,
    };
  }
  const counting = new CountingModelClient(model);
  return {
    callsUsed: () => counting.modelCalls,
    model: counting,
  };
}
