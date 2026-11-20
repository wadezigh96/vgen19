/**
 * Research notes: the sourced, dated facts the researcher found for
 * one market, plus the sources it failed to read. The drafter (ticket
 * 05) builds evidence from these notes, so every finding carries its
 * source link and its date, and nothing in here is ever invented.
 *
 * Vocabulary follows GLOSSARY.md: a finding is a dated, sourced fact
 * about one market; known facts are the findings already recorded for
 * a market, used to skip repeats.
 */

/** One dated, sourced fact about a market. */
export interface ResearchFinding {
  /** The factual claim, in the researcher's own words. */
  claim: string;
  /** URL of the source page the claim came from. */
  sourceUrl: string;
  /** Title of the source page, when known. */
  sourceTitle?: string;
  /**
   * Date of the fact: the source's published date when available,
   * otherwise the date the page was fetched. Always present, so a
   * draft can always date its evidence.
   */
  date: string;
  /** Short verbatim quote supporting the claim, when the model kept one. */
  quote?: string;
}

/** A source page the researcher could not read. Recorded, never fatal. */
export interface FailedSource {
  /** URL that failed. */
  url: string;
  /** Why it failed (status, timeout, network error). */
  reason: string;
}

/**
 * The research notes for one market: every new finding, every failed
 * source, and whether the notes were compacted to fit the context
 * budget before drafting.
 */
export interface ResearchNotes {
  /** Id of the market these notes belong to. */
  marketId: string;
  /** The market question the research answers. */
  question: string;
  /** Dated, sourced findings, newest research first within a run. */
  findings: ResearchFinding[];
  /** Sources that failed to load or to yield findings. */
  failedSources: FailedSource[];
  /** ISO timestamp when the research ran. */
  fetchedAt: string;
  /** True when the notes were compacted to fit the context budget. */
  compacted: boolean;
}

/**
 * A fact already known for a market, stored so later research skips
 * it. The normalized claim plus the source URL is the dedup key: the
 * same claim from the same source is one fact, however it was worded.
 */
export interface KnownFact {
  /** The claim as first recorded. */
  claim: string;
  /** Normalized claim text (see `normalizeClaim`). */
  normalizedClaim: string;
  /** URL of the source page the claim came from. */
  sourceUrl: string;
  /** Date of the fact, when known. */
  date?: string;
  /** ISO timestamp when the fact was recorded. */
  recordedAt: string;
}

/**
 * Normalize claim text for dedup: lowercase, trim, collapse
 * whitespace. Two wordings that differ only in case or spacing are
 * the same fact.
 */
export function normalizeClaim(claim: string): string {
  return claim.toLowerCase().trim().replace(/\s+/g, " ");
}

/**
 * The dedup key for a finding: normalized claim plus source URL. A
 * finding is already known when its key matches a stored known fact
 * for the same market.
 */
export function knownFactKey(claim: string, sourceUrl: string): string {
  return `${normalizeClaim(claim)}\n${sourceUrl.trim()}`;
}

/**
 * Size of notes in characters, measured as the JSON length of the
 * findings plus quotes. The context budget compares against this
 * number; compaction shrinks it by dropping quotes and redundant
 * wording, never by dropping a claim or a source link.
 */
export function measureNotesSize(notes: ResearchNotes): number {
  return JSON.stringify(notes.findings).length;
}
