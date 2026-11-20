import { describe, expect, it } from "vitest";

import { RoutedModelClient } from "../src/llm/client.js";
import { FakeModelProvider } from "../src/llm/fake.js";
import { compactResearchNotes } from "../src/research/index.js";
import type { ResearchNotes } from "../src/research/index.js";

const MODELS = {
  primary: { fast: "fake-fast", strong: "fake-strong" },
};

/** Wrap a fake in the routed client so it satisfies `ExtractionModel`. */
function routedClient(fake: FakeModelProvider): RoutedModelClient {
  return new RoutedModelClient({ budget: 10, models: MODELS, primary: fake });
}

const URL_A = "https://example.invalid/news/zanara-election";
const URL_B = "https://example.invalid/news/zanara-opposition";
const CLAIM_A =
  "The Zanara Election Commission announced a general election for 31 December 2026.";
const CLAIM_B =
  "Zanara opposition parties welcomed the election announcement.";

function notesWithTwoFindings(): ResearchNotes {
  return {
    compacted: false,
    failedSources: [],
    fetchedAt: "2026-11-20T09:00:00.000Z",
    findings: [
      {
        claim: CLAIM_A,
        date: "2025-03-11",
        sourceTitle: "Zanara election announced",
        sourceUrl: URL_A,
      },
      {
        claim: CLAIM_B,
        date: "2025-03-12",
        sourceTitle: "Opposition welcomes Zanara vote",
        sourceUrl: URL_B,
      },
    ],
    marketId: "0x0000000000000000000000000000000000000001",
    question:
      "Will the Republic of Zanara hold a general election before 31 December 2026?",
  };
}

describe("compactResearchNotes", () => {
  it("rejects a model reply that swaps claims between sources", async () => {
    const notes = notesWithTwoFindings();
    // Same finding count, same URL multiset, but each claim is now
    // attached to the other source: a multiset check would pass this.
    const swapped = new FakeModelProvider({
      script: [
        {
          text: JSON.stringify({
            findings: [
              { claim: CLAIM_B, date: "2025-03-11", sourceUrl: URL_A },
              { claim: CLAIM_A, date: "2025-03-12", sourceUrl: URL_B },
            ],
          }),
        },
      ],
    });

    const compacted = await compactResearchNotes(routedClient(swapped), notes, 10);

    // Validation rejected the swap, so deterministic compaction ran:
    // every claim stayed with its original source.
    expect(compacted.compacted).toBe(true);
    expect(compacted.findings).toHaveLength(2);
    expect(
      compacted.findings.find((finding) => finding.sourceUrl === URL_A)
        ?.claim,
    ).toBe(CLAIM_A);
    expect(
      compacted.findings.find((finding) => finding.sourceUrl === URL_B)
        ?.claim,
    ).toBe(CLAIM_B);
  });

  it("accepts a model reply that keeps every claim with its source", async () => {
    const notes = notesWithTwoFindings();
    const faithful = new FakeModelProvider({
      script: [
        {
          text: JSON.stringify({
            findings: [
              // Same claims and URLs; a changed date proves the model
              // path was used rather than the deterministic fallback.
              { claim: CLAIM_A, date: "2025-03-10", sourceUrl: URL_A },
              { claim: CLAIM_B, date: "2025-03-12", sourceUrl: URL_B },
            ],
          }),
        },
      ],
    });

    const compacted = await compactResearchNotes(routedClient(faithful), notes, 10);

    expect(compacted.compacted).toBe(true);
    expect(
      compacted.findings.find((finding) => finding.sourceUrl === URL_A)
        ?.date,
    ).toBe("2025-03-10");
    expect(
      compacted.findings.find((finding) => finding.sourceUrl === URL_A)
        ?.claim,
    ).toBe(CLAIM_A);
  });
});
