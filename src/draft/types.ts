/**
 * Draft domain types: the evidence draft in the exact submission shape
 * (short note plus links, up to 3 files), the self-review rubric
 * score, and the model seam the drafter and the judge share.
 *
 * Vocabulary follows GLOSSARY.md: a draft is an evidence note
 * prepared by Vgen19 but not yet submitted; drafts that fail
 * validation or self-review stay drafts and are reported, never sent.
 * The draft shape here is stable: ticket 06 submits exactly this.
 */

import type {
  ChatMessage,
  CompleteOptions,
  JsonSchema,
  TaskKind,
} from "../llm/types.js";

export { DEFAULT_REVIEW_PASS_THRESHOLD } from "../policy/limits.js";

/** One source link cited by a draft. */
export interface DraftLink {
  /** URL of the source page. Must be a valid http(s) URL. */
  url: string;
  /** Title of the source page, when known. */
  title?: string;
}

/** Lifecycle of a draft: prepared, reviewed, or sent. */
export type DraftStatus = "draft" | "approved" | "rejected" | "submitted";

/** One rubric dimension, scored 0..1 with a short rationale. */
export interface DimensionScore {
  /** Score from 0 (worst) to 1 (best). */
  score: number;
  /** Short reason for the score, for the report. */
  rationale: string;
}

/** The five rubric dimensions the self-review judge scores. */
export type RubricDimension =
  | "sourced"
  | "dated"
  | "novel"
  | "relevant"
  | "noInventedFacts";

/** The self-review score for one draft. */
export interface ReviewScore {
  /** Per-dimension scores. */
  dimensions: Record<RubricDimension, DimensionScore>;
  /** Overall score: the mean of the five dimensions. */
  overall: number;
  /**
   * True when the overall score meets the pass threshold AND every
   * cited link is grounded in the research notes (the sourcing hard
   * gate): a draft with an invented link never passes, however high
   * the mean.
   */
  passed: boolean;
  /** The threshold this score was judged against. */
  threshold: number;
  /** ISO timestamp when the review ran. */
  reviewedAt: string;
}

/**
 * An evidence draft: a short note plus links, in the exact shape the
 * Delphi API accepts (spec story 7). `files` is empty for now: file
 * attachments arrive in a later ticket.
 */
export interface EvidenceDraft {
  /** Unique id for this draft, never reused. */
  id: string;
  /** Id of the market this draft is evidence for. */
  marketId: string;
  /** The short evidence note, at most 2000 characters. */
  note: string;
  /** Source links cited by the note: at least 1, at most 10. */
  links: DraftLink[];
  /** Attached file paths, at most 3. Empty for now. */
  files: string[];
  /** ISO timestamp when the draft was created. */
  createdAt: string;
  /** Review lifecycle state. */
  status: DraftStatus;
  /** Self-review score, once the draft has been reviewed. */
  score?: ReviewScore;
}

/**
 * The model seam the drafter and the self-review judge use:
 * structured JSON output for a task kind. `RoutedModelClient`
 * satisfies this interface, so callers pass the routed client and get
 * routing (drafting and judging go to the strong model), fallback,
 * and the per-cycle budget for free.
 */
export interface DraftModel {
  completeJson<T>(
    taskKind: TaskKind,
    messages: ChatMessage[],
    schema: JsonSchema,
    options?: CompleteOptions,
  ): Promise<T>;
}

/** Maximum note length in characters (spec story 7: a short note). */
export const MAX_DRAFT_NOTE_CHARS = 2000;
/** Maximum links a draft may cite. */
export const MAX_DRAFT_LINKS = 10;
/** Maximum files a draft may attach. */
export const MAX_DRAFT_FILES = 3;
/** Minimum links a draft must cite: evidence without a source is not evidence. */
export const MIN_DRAFT_LINKS = 1;

/** A draft failed strict validation; the message names the violation. */
export class DraftValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DraftValidationError";
  }
}
