/**
 * Strict draft validation (spec story 24): every draft is checked
 * against the submission shape before it may be saved as submittable
 * or sent. Validation is deterministic and throws a
 * `DraftValidationError` naming the first violation found, so a
 * malformed draft never leaves the agent silently.
 */

import {
  DraftValidationError,
  MAX_DRAFT_FILES,
  MAX_DRAFT_LINKS,
  MAX_DRAFT_NOTE_CHARS,
  MIN_DRAFT_LINKS,
  type EvidenceDraft,
} from "./types.js";

function fail(violation: string): never {
  throw new DraftValidationError(`Draft validation failed: ${violation}`);
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Validate a draft against the strict submission shape:
 * non-empty market id; note non-empty and at most 2000 characters;
 * at least 1 and at most 10 links, every one a valid http(s) URL;
 * at most 3 files. Throws `DraftValidationError` naming the first
 * violation; returns nothing when the draft is valid.
 */
export function validateDraft(draft: EvidenceDraft): void {
  if (draft.marketId.trim() === "") {
    fail("marketId must not be empty.");
  }
  if (draft.note.trim() === "") {
    fail("note must not be empty.");
  }
  if (draft.note.length > MAX_DRAFT_NOTE_CHARS) {
    fail(
      `note must be at most ${MAX_DRAFT_NOTE_CHARS} characters, ` +
        `got ${draft.note.length}.`,
    );
  }
  if (draft.links.length < MIN_DRAFT_LINKS) {
    fail(`draft must cite at least ${MIN_DRAFT_LINKS} link.`);
  }
  if (draft.links.length > MAX_DRAFT_LINKS) {
    fail(
      `draft must cite at most ${MAX_DRAFT_LINKS} links, ` +
        `got ${draft.links.length}.`,
    );
  }
  for (const link of draft.links) {
    if (!isHttpUrl(link.url)) {
      fail(`link URL must be a valid http(s) URL, got "${link.url}".`);
    }
  }
  if (draft.files.length > MAX_DRAFT_FILES) {
    fail(
      `draft must attach at most ${MAX_DRAFT_FILES} files, ` +
        `got ${draft.files.length}.`,
    );
  }
}
