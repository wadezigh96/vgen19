/**
 * The draft pipeline: research plus drafting plus self-review for one
 * market, end to end (spec story 19).
 *
 * The pipeline takes an injected `submit` function in its deps. The
 * real submitter arrives in ticket 06; ticket 07 wires it into the
 * mining cycle. Until then the seam exists so the dry-run guarantee
 * is testable: when dry-run mode is on, the pipeline MUST NOT call
 * `submit` under any circumstances, and a rejected draft is never
 * submitted even outside dry-run mode. Only an approved draft in a
 * non-dry-run run is submitted, and its status is then recorded as
 * `submitted`.
 *
 * Notes may be provided (the `draft` command reuses stored notes);
 * otherwise the research loop runs first and its notes are saved.
 * The known-facts snapshot for the novelty check is taken before any
 * research in this run: known facts are only the facts of drafts
 * already submitted, so this run's own findings are never in it and
 * no exclusion workaround is needed.
 */

import type { Market } from "../delphi/types.js";
import type { MemoryStore } from "../memory/store.js";
import type { ResearchNotes } from "../research/notes.js";
import { researchMarket, type ResearcherLimits } from "../research/index.js";
import type { ReadPageFn } from "../research/index.js";
import type { SearchProvider } from "../search/types.js";
import { draftEvidence } from "./drafter.js";
import { reviewDraft } from "./review.js";
import type { DraftModel, EvidenceDraft } from "./types.js";

/** Sends one approved draft to Delphi. Ticket 06 provides the real one. */
export type DraftSubmitter = (draft: EvidenceDraft) => Promise<void>;

export interface DraftPipelineDeps {
  /** The market to draft evidence for. */
  market: Market;
  /** Memory store: notes, known facts, and drafts live here. */
  store: MemoryStore;
  /** Routed model client, used for extraction, drafting, and judging. */
  model: DraftModel;
  /** Search provider, required when no notes are provided. */
  search?: SearchProvider;
  /** Page reader, required when no notes are provided. */
  readPage?: ReadPageFn;
  /** Bounds for the research loop, when it runs. */
  researcherLimits?: ResearcherLimits;
  /**
   * Pre-loaded research notes. When provided, the research loop is
   * skipped and drafting starts from these notes.
   */
  notes?: ResearchNotes;
  /**
   * Submitter to call for an approved draft outside dry-run mode.
   * Never called in dry-run mode, and never called for a rejected
   * draft. Omit it to draft and review without submitting.
   */
  submit?: DraftSubmitter;
  /** When true, draft and review without ever submitting. Default false. */
  dryRun?: boolean;
  /** Self-review pass threshold. Defaults to 0.7. */
  passThreshold?: number;
  /** Clock seam for timestamps. */
  now?: () => Date;
  /** Id generator seam for the draft id. */
  createId?: () => string;
}

export type DraftPipelineResult =
  | {
      outcome: "drafted";
      /** The reviewed draft, saved in memory. */
      draft: EvidenceDraft;
      /** The notes the draft was built from. */
      notes: ResearchNotes;
      /** True only when `submit` was called for this draft. */
      submitted: boolean;
    }
  | {
      outcome: "no-draft";
      /** Why no draft was produced, e.g. "no draft: no findings". */
      reason: string;
      /** The notes that held no findings. */
      notes: ResearchNotes;
    };

/**
 * Run research (unless notes are provided), drafting, and self-review
 * for one market. The draft is always saved with its score and
 * status; submission happens only for an approved draft outside
 * dry-run mode, when a submitter was injected.
 */
export async function runDraftPipeline(
  deps: DraftPipelineDeps,
): Promise<DraftPipelineResult> {
  const dryRun = deps.dryRun ?? false;

  // Novelty baseline: the facts known before this run. Taken before
  // any research, so this run's own findings never count as known.
  // Known facts are only ever the facts of drafts already submitted,
  // so the notes' own findings need no exclusion: a draft built from
  // already-submitted notes scores novel 0, as it should.
  const knownBefore = await deps.store.loadKnownFacts(deps.market.id);

  let notes: ResearchNotes;
  if (deps.notes !== undefined) {
    notes = deps.notes;
  } else {
    if (deps.search === undefined || deps.readPage === undefined) {
      throw new Error(
        `Cannot draft for market ${deps.market.id} without research notes: ` +
          "provide notes, or a search provider and a page reader so the " +
          "research loop can run.",
      );
    }
    notes = await researchMarket(deps.market, {
      limits: deps.researcherLimits,
      model: deps.model,
      now: deps.now,
      readPage: deps.readPage,
      search: deps.search,
      store: deps.store,
    });
    await deps.store.saveResearchNotes(notes);
  }

  const draft = await draftEvidence(notes, deps.model, {
    createId: deps.createId,
    now: deps.now,
  });
  if (draft === undefined) {
    return { notes, outcome: "no-draft", reason: "no draft: no findings" };
  }

  const score = await reviewDraft(draft, notes, deps.model, deps.store, {
    knownFacts: knownBefore,
    now: deps.now,
    passThreshold: deps.passThreshold,
  });
  draft.score = score;
  draft.status = score.passed ? "approved" : "rejected";
  await deps.store.saveDraft(draft);

  // The submit gate: only an approved draft, only outside dry-run
  // mode, only when a submitter was injected. Every other path keeps
  // the draft in memory and never sends it.
  if (!dryRun && deps.submit !== undefined && score.passed) {
    await deps.submit(draft);
    draft.status = "submitted";
    await deps.store.saveDraft(draft);
    return { draft, notes, outcome: "drafted", submitted: true };
  }

  return { draft, notes, outcome: "drafted", submitted: false };
}
