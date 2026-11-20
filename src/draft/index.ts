/**
 * Draft module: the evidence drafter, the strict draft validator, the
 * self-review judge, and the draft pipeline (research plus drafting
 * plus self-review, with a dry-run mode that never submits).
 */

export {
  DEFAULT_REVIEW_PASS_THRESHOLD,
  DraftValidationError,
  MAX_DRAFT_FILES,
  MAX_DRAFT_LINKS,
  MAX_DRAFT_NOTE_CHARS,
  MIN_DRAFT_LINKS,
  type DimensionScore,
  type DraftLink,
  type DraftModel,
  type DraftStatus,
  type EvidenceDraft,
  type ReviewScore,
  type RubricDimension,
} from "./types.js";
export { draftEvidence, type DraftEvidenceOptions } from "./drafter.js";
export {
  runDraftPipeline,
  type DraftPipelineDeps,
  type DraftPipelineResult,
  type DraftSubmitter,
} from "./pipeline.js";
export { reviewDraft, type ReviewDraftOptions } from "./review.js";
export { validateDraft } from "./validate.js";
