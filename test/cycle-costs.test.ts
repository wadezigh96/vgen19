import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { FakeModelProvider } from "../src/llm/fake.js";
import { RoutedModelClient } from "../src/llm/client.js";
import { FakeSearchProvider } from "../src/search/fake.js";
import type {
  SearchOptions,
  SearchProvider,
  SearchResponse,
} from "../src/search/types.js";
import {
  CountingModelClient,
  CountingSearchProvider,
  createModelCallCounter,
  cycleCostPath,
  writeCostRecord,
  type CycleCostRecord,
  type CycleModel,
} from "../src/cycle/costs.js";

let tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vgen19-cycle-costs-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { force: true, recursive: true });
  }
  tempDirs = [];
});

/** A search provider that reports Tavily-style usage credits. */
class UsageSearchProvider implements SearchProvider {
  readonly name = "usage-search";
  constructor(private readonly creditsPerSearch: number) {}

  async search(
    _query: string,
    _options?: SearchOptions,
  ): Promise<SearchResponse> {
    return {
      results: [],
      usage: { credits: this.creditsPerSearch },
    };
  }
}

describe("CountingSearchProvider", () => {
  it("counts every search call, including failed ones", async () => {
    const fake = new FakeSearchProvider({
      results: [],
      script: [{ error: new Error("search boom") }],
    });
    const counting = new CountingSearchProvider(fake);

    await expect(counting.search("first")).rejects.toThrow("search boom");
    await counting.search("second");

    expect(counting.searchCalls).toBe(2);
    // Only the successful search reported credits (the fake reports
    // 1 per search); a failed search reports none.
    expect(counting.searchCreditsUsed).toBe(1);
  });

  it("sums usage credits when the provider reports them", async () => {
    const counting = new CountingSearchProvider(
      new UsageSearchProvider(2),
    );

    await counting.search("first");
    await counting.search("second");

    expect(counting.searchCalls).toBe(2);
    expect(counting.searchCreditsUsed).toBe(4);
  });

  it("delegates results unchanged and keeps the inner provider's name visible", async () => {
    const fake = new FakeSearchProvider({
      results: [
        {
          snippet: "A snippet.",
          title: "A title",
          url: "https://example.invalid/a",
        },
      ],
    });
    const counting = new CountingSearchProvider(fake);

    const response = await counting.search("a query");

    expect(response.results).toHaveLength(1);
    expect(counting.name).toContain("fake-search");
  });
});

describe("CountingModelClient", () => {
  it("counts completeJson calls and delegates replies", async () => {
    const fake = new FakeModelProvider({
      defaultText: JSON.stringify({ findings: [] }),
    });
    const client = new RoutedModelClient({
      models: { primary: { fast: "fake-fast", strong: "fake-strong" } },
      primary: fake,
    });
    const counting = new CountingModelClient(client);

    await counting.completeJson(
      "extraction",
      [],
      { properties: { findings: { items: { properties: {}, type: "object" }, type: "array" } }, required: ["findings"], type: "object" },
    );

    expect(counting.modelCalls).toBe(1);
    expect(fake.calls).toHaveLength(1);
  });
});

describe("createModelCallCounter", () => {
  it("reads the routed client's own counter when it has one", async () => {
    const fake = new FakeModelProvider({
      defaultText: JSON.stringify({ findings: [] }),
    });
    const client = new RoutedModelClient({
      models: { primary: { fast: "fake-fast", strong: "fake-strong" } },
      primary: fake,
    });
    const counter = createModelCallCounter(client);

    // The counter hands back the same client: no wrapper in the way.
    expect(counter.model).toBe(client);
    expect(counter.callsUsed()).toBe(0);
    await counter.model.completeJson(
      "extraction",
      [],
      { properties: { findings: { items: { properties: {}, type: "object" }, type: "array" } }, required: ["findings"], type: "object" },
    );
    expect(counter.callsUsed()).toBe(1);
  });

  it("wraps a bare model in a counting decorator when it has no counter", async () => {
    const bare: CycleModel = {
      completeJson: async <T>() => ({ findings: [] }) as T,
    };
    const counter = createModelCallCounter(bare);

    expect(counter.model).not.toBe(bare);
    expect(counter.callsUsed()).toBe(0);
    await counter.model.completeJson(
      "extraction",
      [],
      { properties: {}, type: "object" },
    );
    expect(counter.callsUsed()).toBe(1);
  });
});

describe("writeCostRecord", () => {
  it("persists the cost record as JSON under costs/<cycle-id>.json", async () => {
    const dataDir = await makeTempDir();
    const record: CycleCostRecord = {
      cycleId: "cycle-test-1",
      modelCalls: 12,
      recordedAt: "2026-11-20T10:05:00.000Z",
      searchCalls: 9,
      searchCreditsUsed: 0,
    };

    const path = await writeCostRecord(dataDir, record);

    expect(path).toBe(cycleCostPath(dataDir, "cycle-test-1"));
    const stored = JSON.parse(
      await readFile(path, "utf-8"),
    ) as CycleCostRecord;
    expect(stored).toEqual(record);
  });

  it("refuses a cycle id that would escape the data dir", async () => {
    const dataDir = await makeTempDir();

    expect(() => cycleCostPath(dataDir, "../../x")).toThrow(/cycle id/i);
    expect(() => cycleCostPath(dataDir, "")).toThrow(/cycle id/i);
  });
});
