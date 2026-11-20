/**
 * Research module: the per-market research loop (search, read,
 * extract, dedup, compact), the notes it produces, and the page
 * reader it reads sources with.
 */

export {
  compactResearchNotes,
  type ExtractionModel,
} from "./compaction.js";
export {
  DEFAULT_MAX_MODEL_CALLS_PER_MARKET,
  DEFAULT_MAX_PAGES_PER_MARKET,
  DEFAULT_MAX_SEARCHES_PER_MARKET,
  DEFAULT_NOTES_CHAR_BUDGET,
  deriveSearchQueries,
  researchMarket,
  type ResearcherDeps,
  type ResearcherLimits,
} from "./researcher.js";
export {
  knownFactKey,
  measureNotesSize,
  normalizeClaim,
  type FailedSource,
  type KnownFact,
  type ResearchFinding,
  type ResearchNotes,
} from "./notes.js";
export {
  createPageReader,
  DEFAULT_MAX_PAGE_BYTES,
  DEFAULT_PAGE_TIMEOUT_MS,
  extractReadableText,
  PageReadError,
  type CreatePageReaderOptions,
  type PageContent,
  type PageFetchFn,
  type PageFetchResponse,
  type ReadPageFn,
} from "./reader.js";
