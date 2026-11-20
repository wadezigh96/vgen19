import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { fixtureMarkets } from "../src/delphi/fixtures.js";
import {
  draftEvidence,
  DraftValidationError,
  MAX_DRAFT_LINKS,
  MAX_DRAFT_NOTE_CHARS,
  reviewDraft,
  validateDraft,
  type EvidenceDraft,
} from "../src/draft/index.js";
import { FakeModelProvider } from "../src/llm/fake.js";
import { RoutedModelClient } from "../src/llm/client.js";
import { MemoryStore } from "../src/memory/store.js";
import type { ResearchNotes } from "../src/research/index.js";

let tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vgen19-draft-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { force: true, recursive: true });
  }
  tempDirs = [];
});

const MARKET_ID = fixtureMarkets[0]!.id;

function validDraft(overrides: Partial<EvidenceDraft> = {}): EvidenceDraft {
  return {
    createdAt: "2026-11-20T10:00:00.000Z",
    files: [],
    id: "draft-1",
    links: [
      {
        title: "Zanara election announced",
        url: "https://example.invalid/news/zanara-election",
      },
    ],
    marketId: MARKET_ID,
    note: "The Zanara Election Commission announced a general election for 31 December 2026 (2025-03-11).",
    status: "draft",
    ...overrides,
  };
}

describe("validateDraft", () => {
  it("accepts a well-formed draft in the submission shape", () => {
    expect(() => validateDraft(validDraft())).not.toThrow();
  });

  it("rejects an empty note, naming the violation", () => {
    expect(() => validateDraft(validDraft({ note: "   " }))).toThrow(
      DraftValidationError,
    );
    expect(() => validateDraft(validDraft({ note: "" }))).toThrow(/note/);
  });

  it("rejects a note longer than the limit", () => {
    const tooLong = "x".repeat(MAX_DRAFT_NOTE_CHARS + 1);

    expect(() => validateDraft(validDraft({ note: tooLong }))).toThrow(
      DraftValidationError,
    );
    expect(() => validateDraft(validDraft({ note: tooLong }))).toThrow(
      /2000/,
    );
  });

  it("accepts a note exactly at the limit", () => {
    const atLimit = "x".repeat(MAX_DRAFT_NOTE_CHARS);

    expect(() => validateDraft(validDraft({ note: atLimit }))).not.toThrow();
  });

  it("rejects a draft with no links", () => {
    expect(() => validateDraft(validDraft({ links: [] }))).toThrow(
      DraftValidationError,
    );
    expect(() => validateDraft(validDraft({ links: [] }))).toThrow(/link/);
  });

  it("rejects a draft with too many links", () => {
    const links = Array.from({ length: MAX_DRAFT_LINKS + 1 }, (_, i) => ({
      url: `https://example.invalid/news/${i}`,
    }));

    expect(() => validateDraft(validDraft({ links }))).toThrow(
      DraftValidationError,
    );
    expect(() => validateDraft(validDraft({ links }))).toThrow(/10/);
  });

  it("rejects a link that is not a valid http(s) URL", () => {
    expect(() =>
      validateDraft(validDraft({ links: [{ url: "not a url" }] })),
    ).toThrow(DraftValidationError);
    expect(() =>
      validateDraft(validDraft({ links: [{ url: "not a url" }] })),
    ).toThrow(/url/i);
    expect(() =>
      validateDraft(
        validDraft({ links: [{ url: "ftp://example.invalid/file" }] }),
      ),
    ).toThrow(DraftValidationError);
  });

  it("rejects a draft with too many files", () => {
    expect(() =>
      validateDraft(
        validDraft({ files: ["a.txt", "b.txt", "c.txt", "d.txt"] }),
      ),
    ).toThrow(DraftValidationError);
    expect(() =>
      validateDraft(
        validDraft({ files: ["a.txt", "b.txt", "c.txt", "d.txt"] }),
      ),
    ).toThrow(/file/);
  });

  it("rejects an empty market id", () => {
    expect(() => validateDraft(validDraft({ marketId: "  " }))).toThrow(
      DraftValidationError,
    );
    expect(() => validateDraft(validDraft({ marketId: "  " }))).toThrow(
      /marketId/,
    );
  });
});

const ELECTION_URL = "https://example.invalid/news/zanara-election";
const FIXED_NOW = new Date("2026-11-20T10:00:00.000Z");

function notesWithFindings(): ResearchNotes {
  return {
    compacted: false,
    failedSources: [],
    fetchedAt: "2026-11-20T09:00:00.000Z",
    findings: [
      {
        claim:
          "The Zanara Election Commission announced a general election for 31 December 2026.",
        date: "2025-03-11",
        sourceTitle: "Zanara election announced",
        sourceUrl: ELECTION_URL,
      },
    ],
    marketId: MARKET_ID,
    question:
      "Will the Republic of Zanara hold a general election before 31 December 2026?",
  };
}

function routedClient(fake: FakeModelProvider): RoutedModelClient {
  return new RoutedModelClient({
    models: { primary: { fast: "fake-fast", strong: "fake-strong" } },
    primary: fake,
  });
}

describe("draftEvidence", () => {
  it("drafts a note with links from the research findings", async () => {
    const fake = new FakeModelProvider({
      script: [
        {
          text: JSON.stringify({
            links: [
              { title: "Zanara election announced", url: ELECTION_URL },
            ],
            note: "The Zanara Election Commission announced a general election for 31 December 2026 (2025-03-11).",
          }),
        },
      ],
    });

    const draft = await draftEvidence(notesWithFindings(), routedClient(fake), {
      createId: () => "draft-1",
      now: () => FIXED_NOW,
    });

    expect(draft).toBeDefined();
    expect(draft!.id).toBe("draft-1");
    expect(draft!.marketId).toBe(MARKET_ID);
    expect(draft!.note).toContain("general election for 31 December 2026");
    expect(draft!.note).toContain("2025-03-11");
    expect(draft!.links).toEqual([
      { title: "Zanara election announced", url: ELECTION_URL },
    ]);
    expect(draft!.files).toEqual([]);
    expect(draft!.createdAt).toBe("2026-11-20T10:00:00.000Z");
    expect(draft!.status).toBe("draft");
    expect(draft!.score).toBeUndefined();
  });

  it("uses the strong model: drafting is routed to the drafting task kind", async () => {
    const fake = new FakeModelProvider({
      script: [
        {
          text: JSON.stringify({
            links: [{ url: ELECTION_URL }],
            note: "The Zanara Election Commission announced a general election for 31 December 2026.",
          }),
        },
      ],
    });

    await draftEvidence(notesWithFindings(), routedClient(fake));

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.model).toBe("fake-strong");
    expect(fake.calls[0]!.jsonMode).toBe(true);
  });

  it("tells the model to draft only from the findings and never invent facts", async () => {
    const fake = new FakeModelProvider({
      script: [
        {
          text: JSON.stringify({
            links: [{ url: ELECTION_URL }],
            note: "The Zanara Election Commission announced a general election for 31 December 2026.",
          }),
        },
      ],
    });

    await draftEvidence(notesWithFindings(), routedClient(fake));

    const sent = fake.calls[0]!.messages
      .map((message) => message.content)
      .join("\n");
    expect(sent).toContain(
      "The Zanara Election Commission announced a general election for 31 December 2026.",
    );
    expect(sent).toContain(ELECTION_URL);
    expect(sent).toMatch(/only from/i);
    expect(sent).toMatch(/never invent/i);
  });

  it("returns no draft when the notes have no findings, without calling the model", async () => {
    const fake = new FakeModelProvider();
    const emptyNotes: ResearchNotes = {
      ...notesWithFindings(),
      findings: [],
    };

    const draft = await draftEvidence(emptyNotes, routedClient(fake));

    expect(draft).toBeUndefined();
    expect(fake.calls).toHaveLength(0);
  });

  it("rejects model output that fails validation instead of returning a bad draft", async () => {
    const fake = new FakeModelProvider({
      script: [
        {
          text: JSON.stringify({
            links: [{ url: "not a url" }],
            note: "",
          }),
        },
      ],
    });

    await expect(
      draftEvidence(notesWithFindings(), routedClient(fake)),
    ).rejects.toThrow(DraftValidationError);
  });
});

function judgeReply(scores: {
  sourced: number;
  novel: number;
  relevant: number;
  noInventedFacts: number;
}): string {
  return JSON.stringify({
    noInventedFacts: {
      rationale: "Judge: every claim is supported by the findings.",
      score: scores.noInventedFacts,
    },
    novel: {
      rationale: "Judge: the facts are new.",
      score: scores.novel,
    },
    relevant: {
      rationale: "Judge: the note answers the question.",
      score: scores.relevant,
    },
    sourced: {
      rationale: "Judge: the claims cite their links.",
      score: scores.sourced,
    },
  });
}

const STRONG_JUDGMENT = judgeReply({
  noInventedFacts: 1,
  novel: 1,
  relevant: 1,
  sourced: 1,
});

describe("reviewDraft", () => {
  it("passes a strong draft: every dimension scores 1 and the overall is 1", async () => {
    const store = new MemoryStore(await makeTempDir());
    const fake = new FakeModelProvider({ script: [{ text: STRONG_JUDGMENT }] });

    const score = await reviewDraft(
      validDraft(),
      notesWithFindings(),
      routedClient(fake),
      store,
      { now: () => FIXED_NOW },
    );

    expect(score.passed).toBe(true);
    expect(score.overall).toBeCloseTo(1);
    expect(score.threshold).toBe(0.7);
    expect(score.reviewedAt).toBe("2026-11-20T10:00:00.000Z");
    for (const dimension of [
      "sourced",
      "dated",
      "novel",
      "relevant",
      "noInventedFacts",
    ] as const) {
      expect(score.dimensions[dimension].score).toBeCloseTo(1);
      expect(score.dimensions[dimension].rationale).not.toBe("");
    }
  });

  it("judges with the strong model: judging is routed to the judging task kind", async () => {
    const store = new MemoryStore(await makeTempDir());
    const fake = new FakeModelProvider({ script: [{ text: STRONG_JUDGMENT }] });

    await reviewDraft(
      validDraft(),
      notesWithFindings(),
      routedClient(fake),
      store,
    );

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.model).toBe("fake-strong");
    expect(fake.calls[0]!.jsonMode).toBe(true);
  });

  it("fails a weak draft: unsourced links plus invented claims score below the threshold", async () => {
    const store = new MemoryStore(await makeTempDir());
    const fake = new FakeModelProvider({
      script: [
        {
          text: judgeReply({
            noInventedFacts: 0.1,
            novel: 1,
            relevant: 0.2,
            sourced: 1,
          }),
        },
      ],
    });
    // The link is a valid URL but does not appear in the notes' sources.
    const weak = validDraft({
      links: [{ url: "https://example.invalid/news/unrelated" }],
      note: "Zanara will hold an election next week, and the president already resigned.",
    });

    const score = await reviewDraft(
      weak,
      notesWithFindings(),
      routedClient(fake),
      store,
    );

    expect(score.passed).toBe(false);
    expect(score.overall).toBeLessThan(0.7);
    expect(score.dimensions.sourced.score).toBe(0);
    expect(score.dimensions.noInventedFacts.score).toBeCloseTo(0.1);
  });

  it("gates sourced on the deterministic check: a link outside the notes scores 0 even when the judge is generous", async () => {
    const store = new MemoryStore(await makeTempDir());
    const fake = new FakeModelProvider({ script: [{ text: STRONG_JUDGMENT }] });
    const unsourced = validDraft({
      links: [{ url: "https://example.invalid/news/unrelated" }],
    });

    const score = await reviewDraft(
      unsourced,
      notesWithFindings(),
      routedClient(fake),
      store,
    );

    expect(score.dimensions.sourced.score).toBe(0);
    expect(score.dimensions.sourced.rationale).toContain("0 of 1");
  });

  it("rejects a draft with an unsourced link even when every other dimension scores perfectly", async () => {
    const store = new MemoryStore(await makeTempDir());
    const fake = new FakeModelProvider({ script: [{ text: STRONG_JUDGMENT }] });
    // Two links: one grounded in the notes, one invented. The mean
    // of the five dimensions would be 0.9, above the threshold, but
    // grounding is a hard gate: an invented link fails the review.
    const halfSourced = validDraft({
      links: [
        { title: "Zanara election announced", url: ELECTION_URL },
        { url: "https://example.invalid/news/invented" },
      ],
    });

    const score = await reviewDraft(
      halfSourced,
      notesWithFindings(),
      routedClient(fake),
      store,
    );

    expect(score.dimensions.sourced.score).toBeCloseTo(0.5);
    expect(score.overall).toBeCloseTo(0.9);
    expect(score.passed).toBe(false);
  });

  it("scores novel low when a finding overlaps a known fact already in memory", async () => {
    const store = new MemoryStore(await makeTempDir());
    await store.addKnownFacts(MARKET_ID, [
      {
        claim:
          "The Zanara Election Commission announced a general election for 31 December 2026.",
        normalizedClaim:
          "the zanara election commission announced a general election for 31 december 2026.",
        recordedAt: "2026-11-19T10:00:00.000Z",
        sourceUrl: ELECTION_URL,
      },
    ]);
    const fake = new FakeModelProvider({ script: [{ text: STRONG_JUDGMENT }] });

    const score = await reviewDraft(
      validDraft(),
      notesWithFindings(),
      routedClient(fake),
      store,
    );

    expect(score.dimensions.novel.score).toBe(0);
    expect(score.dimensions.novel.rationale).toContain("overlap");
  });

  it("judges novelty against a pre-research snapshot when one is given", async () => {
    const store = new MemoryStore(await makeTempDir());
    // The finding was recorded as a known fact by this run's research,
    // so it must not count as already known: the snapshot predates it.
    await store.addKnownFacts(MARKET_ID, [
      {
        claim:
          "The Zanara Election Commission announced a general election for 31 December 2026.",
        normalizedClaim:
          "the zanara election commission announced a general election for 31 december 2026.",
        recordedAt: "2026-11-20T09:30:00.000Z",
        sourceUrl: ELECTION_URL,
      },
    ]);
    const fake = new FakeModelProvider({ script: [{ text: STRONG_JUDGMENT }] });

    const score = await reviewDraft(
      validDraft(),
      notesWithFindings(),
      routedClient(fake),
      store,
      { knownFacts: [] },
    );

    expect(score.dimensions.novel.score).toBe(1);
  });

  it("scores dated 1 when the note carries a date, and 0.5 when only the findings do", async () => {
    const store = new MemoryStore(await makeTempDir());
    const fake = new FakeModelProvider({
      script: [{ text: STRONG_JUDGMENT }, { text: STRONG_JUDGMENT }],
    });

    const dated = await reviewDraft(
      validDraft(),
      notesWithFindings(),
      routedClient(fake),
      store,
    );
    expect(dated.dimensions.dated.score).toBe(1);

    const undatedNote = await reviewDraft(
      validDraft({
        note: "The Zanara Election Commission announced a general election.",
      }),
      notesWithFindings(),
      routedClient(fake),
      store,
    );
    expect(undatedNote.dimensions.dated.score).toBe(0.5);
  });

  it("applies a configurable pass threshold", async () => {
    const store = new MemoryStore(await makeTempDir());
    const judgment = judgeReply({
      noInventedFacts: 0.8,
      novel: 0.8,
      relevant: 0.8,
      sourced: 0.8,
    });
    const fake = new FakeModelProvider({
      script: [{ text: judgment }, { text: judgment }],
    });
    const model = routedClient(fake);

    const strict = await reviewDraft(
      validDraft(),
      notesWithFindings(),
      model,
      store,
      { passThreshold: 0.9 },
    );
    expect(strict.overall).toBeCloseTo(0.84);
    expect(strict.passed).toBe(false);

    const lenient = await reviewDraft(
      validDraft(),
      notesWithFindings(),
      model,
      store,
      { passThreshold: 0.8 },
    );
    expect(lenient.overall).toBeCloseTo(0.84);
    expect(lenient.passed).toBe(true);
  });

  it("clamps out-of-range judge scores to 0..1", async () => {
    const store = new MemoryStore(await makeTempDir());
    const fake = new FakeModelProvider({
      script: [
        {
          text: judgeReply({
            noInventedFacts: -0.5,
            novel: 1.5,
            relevant: 2,
            sourced: 1.5,
          }),
        },
      ],
    });

    const score = await reviewDraft(
      validDraft(),
      notesWithFindings(),
      routedClient(fake),
      store,
    );

    expect(score.dimensions.sourced.score).toBe(1);
    expect(score.dimensions.novel.score).toBe(1);
    expect(score.dimensions.relevant.score).toBe(1);
    expect(score.dimensions.noInventedFacts.score).toBe(0);
  });

  it("refuses to review a draft that fails validation", async () => {
    const store = new MemoryStore(await makeTempDir());
    const fake = new FakeModelProvider({ script: [{ text: STRONG_JUDGMENT }] });

    await expect(
      reviewDraft(
        validDraft({ note: "" }),
        notesWithFindings(),
        routedClient(fake),
        store,
      ),
    ).rejects.toThrow(DraftValidationError);
    expect(fake.calls).toHaveLength(0);
  });
});
