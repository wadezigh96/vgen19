/**
 * Long-term memory store: JSON files under the configured data dir,
 * one file per collection, keyed by record id.
 *
 * Later tickets extend this store with more collections by adding
 * one method pair per collection on top of the generic
 * `readCollection` / `writeCollection` helpers below; the file
 * layout and atomic-write behaviour stay the same. Known facts and
 * research notes already live here (ticket 04); submissions,
 * approvals, rewards, and refusals live here too (ticket 06).
 *
 * Writes are atomic: each collection is written to a temporary file in
 * the same directory and then renamed over the target, so an
 * interrupted cycle loses no records.
 */

import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { Market } from "../delphi/types.js";
import type { EvidenceDraft } from "../draft/types.js";
import {
  knownFactKey,
  type KnownFact,
  type ResearchNotes,
} from "../research/notes.js";
import type {
  Approval,
  PendingSubmission,
  RewardRecord,
  SubmissionRecord,
  SubmissionRefusal,
} from "../submit/types.js";
import { writeFileAtomic } from "../util.js";

export type { EvidenceDraft } from "../draft/types.js";
export type { KnownFact, ResearchNotes } from "../research/notes.js";
export type {
  Approval,
  PendingSubmission,
  RewardRecord,
  SubmissionRecord,
  SubmissionRefusal,
} from "../submit/types.js";

export class MemoryStore {
  private readonly dataDir: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  /** Load all stored markets, in first-stored order. Empty when none stored. */
  async loadMarkets(): Promise<Market[]> {
    const records = await this.readCollection<Market>("markets.json");
    return Object.values(records);
  }

  /**
   * Upsert markets by id: new markets are added, stored markets are
   * updated in place, and nothing is ever duplicated.
   */
  async saveMarkets(markets: Market[]): Promise<void> {
    const records = await this.readCollection<Market>("markets.json");
    for (const market of markets) {
      records[market.id] = market;
    }
    await this.writeCollection("markets.json", records);
  }

  /**
   * Load the facts already known for one market, in first-recorded
   * order. Empty when none were recorded yet.
   */
  async loadKnownFacts(marketId: string): Promise<KnownFact[]> {
    const records = await this.readCollection<KnownFact[]>(
      "known-facts.json",
    );
    return records[marketId] ?? [];
  }

  /**
   * Record new facts for one market. A fact whose normalized claim
   * plus source URL already exists for the market is skipped, so the
   * same fact is never stored twice however it was worded.
   */
  async addKnownFacts(marketId: string, facts: KnownFact[]): Promise<void> {
    const records = await this.readCollection<KnownFact[]>(
      "known-facts.json",
    );
    const existing = records[marketId] ?? [];
    const seen = new Set(
      existing.map((fact) => knownFactKey(fact.claim, fact.sourceUrl)),
    );
    for (const fact of facts) {
      const key = knownFactKey(fact.claim, fact.sourceUrl);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      existing.push(fact);
    }
    records[marketId] = existing;
    await this.writeCollection("known-facts.json", records);
  }

  /** Load the latest research notes for one market, if any. */
  async loadResearchNotes(
    marketId: string,
  ): Promise<ResearchNotes | undefined> {
    const records = await this.readCollection<ResearchNotes>(
      "research-notes.json",
    );
    return records[marketId];
  }

  /** Store the latest research notes for their market, replacing any older notes. */
  async saveResearchNotes(notes: ResearchNotes): Promise<void> {
    const records = await this.readCollection<ResearchNotes>(
      "research-notes.json",
    );
    records[notes.marketId] = notes;
    await this.writeCollection("research-notes.json", records);
  }

  /**
   * Load one draft by id, with its score and status. Undefined when no
   * draft with that id was saved.
   */
  async loadDraft(draftId: string): Promise<EvidenceDraft | undefined> {
    const records = await this.readCollection<EvidenceDraft>("drafts.json");
    return records[draftId];
  }

  /**
   * Load saved drafts in first-saved order, optionally for one market
   * only. Drafts are append-only history: a new draft for a market
   * never overwrites an older one, so reporting can see every attempt.
   */
  async loadDrafts(marketId?: string): Promise<EvidenceDraft[]> {
    const records = await this.readCollection<EvidenceDraft>("drafts.json");
    const drafts = Object.values(records);
    if (marketId === undefined) {
      return drafts;
    }
    return drafts.filter((draft) => draft.marketId === marketId);
  }

  /**
   * Save a draft (with its score and status) keyed by its id. Saving
   * the same draft again updates its record (for example when its
   * status moves from approved to submitted); a new draft always
   * carries a new id, so history is never overwritten.
   */
  async saveDraft(draft: EvidenceDraft): Promise<void> {
    const records = await this.readCollection<EvidenceDraft>("drafts.json");
    records[draft.id] = draft;
    await this.writeCollection("drafts.json", records);
  }

  /** Load one submission by its id, with its receipt. Undefined when unknown. */
  async loadSubmission(
    submissionId: string,
  ): Promise<SubmissionRecord | undefined> {
    const records =
      await this.readCollection<SubmissionRecord>("submissions.json");
    return records[submissionId];
  }

  /**
   * Load stored submissions in first-recorded order, optionally for
   * one market, one cycle, or one draft only. The submitter counts
   * these to enforce the per-market cap (3) and the per-cycle cap,
   * and checks by draft id to resolve a submission that was already
   * recorded before a crash.
   */
  async loadSubmissions(filter?: {
    marketId?: string;
    cycleId?: string;
    draftId?: string;
  }): Promise<SubmissionRecord[]> {
    const records =
      await this.readCollection<SubmissionRecord>("submissions.json");
    const submissions = Object.values(records);
    return submissions.filter((submission) => {
      if (
        filter?.marketId !== undefined &&
        submission.marketId !== filter.marketId
      ) {
        return false;
      }
      if (
        filter?.cycleId !== undefined &&
        submission.cycleId !== filter.cycleId
      ) {
        return false;
      }
      if (
        filter?.draftId !== undefined &&
        submission.draftId !== filter.draftId
      ) {
        return false;
      }
      return true;
    });
  }

  /**
   * Save a submission (with its receipt) keyed by its id. Submissions
   * are append-only history: a new submission always carries a new
   * id, so reporting can see every attempt.
   */
  async saveSubmission(submission: SubmissionRecord): Promise<void> {
    const records =
      await this.readCollection<SubmissionRecord>("submissions.json");
    records[submission.id] = submission;
    await this.writeCollection("submissions.json", records);
  }

  /**
   * Record a submission in flight, before the network call. One
   * pending record per draft: a second attempt for the same draft
   * overwrites the first, which is safe because the submitter
   * refuses while one exists.
   */
  async savePendingSubmission(pending: PendingSubmission): Promise<void> {
    const records = await this.readCollection<PendingSubmission>(
      "pending-submissions.json",
    );
    records[pending.draftId] = pending;
    await this.writeCollection("pending-submissions.json", records);
  }

  /** Load the pending submission for one draft, if any. */
  async loadPendingSubmission(
    draftId: string,
  ): Promise<PendingSubmission | undefined> {
    const records = await this.readCollection<PendingSubmission>(
      "pending-submissions.json",
    );
    return records[draftId];
  }

  /** Delete the pending submission for one draft, if any. */
  async deletePendingSubmission(draftId: string): Promise<void> {
    const records = await this.readCollection<PendingSubmission>(
      "pending-submissions.json",
    );
    if (!(draftId in records)) {
      return;
    }
    delete records[draftId];
    await this.writeCollection("pending-submissions.json", records);
  }

  /**
   * Load the human approval for one draft, if any. Approval is
   * per-draft, not per-market.
   */
  async loadApproval(draftId: string): Promise<Approval | undefined> {
    const records = await this.readCollection<Approval>("approvals.json");
    return records[draftId];
  }

  /** Save a human approval for its draft, replacing any older one. */
  async saveApproval(approval: Approval): Promise<void> {
    const records = await this.readCollection<Approval>("approvals.json");
    records[approval.draftId] = approval;
    await this.writeCollection("approvals.json", records);
  }

  /** Load the rewards one submission earned, if any. */
  async loadReward(submissionId: string): Promise<RewardRecord | undefined> {
    const records = await this.readCollection<RewardRecord>("rewards.json");
    return records[submissionId];
  }

  /** Load all recorded rewards in first-recorded order. */
  async loadRewards(): Promise<RewardRecord[]> {
    const records = await this.readCollection<RewardRecord>("rewards.json");
    return Object.values(records);
  }

  /**
   * Save the rewards for one submission, keyed by submission id.
   * Saving the same submission again updates its record (for example
   * when a settlement reward arrives after the judgment reward), so
   * rewards stay attached to the submission that earned them.
   */
  async saveReward(reward: RewardRecord): Promise<void> {
    const records = await this.readCollection<RewardRecord>("rewards.json");
    records[reward.submissionId] = reward;
    await this.writeCollection("rewards.json", records);
  }

  /**
   * Record a refused submission attempt. Refusals are never
   * submissions: they are kept so reports can show them, and they
   * never count toward the caps.
   */
  async recordRefusal(refusal: SubmissionRefusal): Promise<void> {
    const records =
      await this.readCollection<SubmissionRefusal>("refusals.json");
    records[refusal.id] = refusal;
    await this.writeCollection("refusals.json", records);
  }

  /** Load refused attempts in first-recorded order, optionally for one market. */
  async loadRefusals(filter?: {
    marketId?: string;
  }): Promise<SubmissionRefusal[]> {
    const records =
      await this.readCollection<SubmissionRefusal>("refusals.json");
    const refusals = Object.values(records);
    if (filter?.marketId === undefined) {
      return refusals;
    }
    return refusals.filter((refusal) => refusal.marketId === filter.marketId);
  }

  /**
   * Read one collection file as a record keyed by id. A missing file
   * means an empty collection; a missing data dir is created on write.
   */
  private async readCollection<T>(
    fileName: string,
  ): Promise<Record<string, T>> {
    try {
      const raw = await readFile(join(this.dataDir, fileName), "utf-8");
      return JSON.parse(raw) as Record<string, T>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return {};
      }
      throw error;
    }
  }

  /** Write one collection atomically: temp file plus rename. */
  private async writeCollection<T>(
    fileName: string,
    records: Record<string, T>,
  ): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    await writeFileAtomic(
      join(this.dataDir, fileName),
      `${JSON.stringify(records, null, 2)}\n`,
    );
  }
}
