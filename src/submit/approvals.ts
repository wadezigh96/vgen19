/**
 * Human approvals for the approval gate (ADR 0004).
 *
 * An approval is a small record saying a human reviewed one draft and
 * allowed it to be sent. The submitter checks for it when the gate
 * is enabled; approval is per-draft, not per-market. The `approve`
 * CLI command calls `approveDraft` below.
 */

import type { MemoryStore } from "../memory/store.js";
import type { Approval } from "./types.js";

export interface ApproveDraftOptions {
  /** Clock seam for the approval timestamp. */
  now?: () => Date;
}

/**
 * Record a human approval for one draft and return it. Throws when
 * no draft with that id exists: approving a draft that was never
 * saved is a mistake, not an approval. The draft's status is left
 * alone: the submitter still requires status `approved` (the
 * self-review pass) on top of this record.
 */
export async function approveDraft(
  store: MemoryStore,
  draftId: string,
  note?: string,
  options: ApproveDraftOptions = {},
): Promise<Approval> {
  const draft = await store.loadDraft(draftId);
  if (draft === undefined) {
    throw new Error(`Draft not found: ${draftId}.`);
  }
  const now = options.now ?? (() => new Date());
  const approval: Approval = {
    approvedAt: now().toISOString(),
    approvedBy: "human",
    draftId: draft.id,
    ...(note !== undefined ? { note } : {}),
  };
  await store.saveApproval(approval);
  return approval;
}
