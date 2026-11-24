/**
 * Stub Delphi adapter: returns recorded fixtures instead of calling a
 * live API. No network, no key, no endpoints.
 */

import { AGENT_NAME, HARNESS } from "../agent.js";
import type {
  DelphiAdapter,
  GetMarketParams,
  ListMarketsParams,
} from "./adapter.js";
import type { EvidenceDraft } from "../draft/types.js";
import { fixtureMarkets } from "./fixtures.js";
import type { AgentIdentity, Market } from "./types.js";

/** Default identity for the stub: no model is involved in listing markets. */
export const STUB_IDENTITY: AgentIdentity = {
  agentName: AGENT_NAME,
  harness: HARNESS,
  model: "stub",
};

/** One submission the stub recorded, in call order. */
export interface RecordedSubmission {
  /** The draft that was sent. */
  draft: EvidenceDraft;
  /** The identity sent with the request. */
  meta: AgentIdentity;
}

export class StubDelphiAdapter implements DelphiAdapter {
  readonly identity: AgentIdentity;
  /** Identities recorded with each request, in call order. */
  readonly recordedRequests: AgentIdentity[] = [];
  /** Submissions recorded with each `submitEvidence` call, in call order. */
  readonly recordedSubmissions: RecordedSubmission[] = [];
  private submissionCounter = 0;

  constructor(identity: AgentIdentity = STUB_IDENTITY) {
    this.identity = identity;
  }

  /**
   * Return the fixture markets, honoring the status, category, and
   * verifiable filters plus skip/limit pagination. `orderBy`,
   * `competitionId`, and `pricesAndImpliedProbabilities` have no
   * meaning against fixtures and are ignored.
   */
  async listMarkets(params: ListMarketsParams = {}): Promise<Market[]> {
    this.recordedRequests.push(this.identity);
    const filtered = fixtureMarkets.filter((market) => {
      if (params.status !== undefined && market.status !== params.status) {
        return false;
      }
      if (
        params.category !== undefined &&
        market.category !== params.category
      ) {
        return false;
      }
      if (
        params.verifiable !== undefined &&
        market.verifiable !== params.verifiable
      ) {
        return false;
      }
      return true;
    });
    // Clamp to >= 0: a negative skip would make slice count from the
    // end of the list instead of from the start.
    const skip = Math.max(0, params.skip ?? 0);
    const limit =
      params.limit === undefined ? undefined : Math.max(0, params.limit);
    const end = limit === undefined ? undefined : skip + limit;
    // Fresh deep copy so callers can never mutate the fixtures.
    return structuredClone(filtered.slice(skip, end));
  }

  async getMarket(params: GetMarketParams): Promise<Market> {
    this.recordedRequests.push(this.identity);
    const market = fixtureMarkets.find((candidate) => candidate.id === params.id);
    if (market === undefined) {
      throw new Error(`Market not found: ${params.id}`);
    }
    return structuredClone(market);
  }

  async health(): Promise<{ status: string }> {
    // The health check needs no authentication, so it sends no identity.
    return { status: "ok" };
  }

  /**
   * Record the submission and return a canned accepted receipt. No
   * network, no key, no endpoints: the live client lives behind the
   * plug-in point in `createDelphiAdapter`. The canned receipt
   * carries no reward; rewards are exercised through fakes.
   */
  async submitEvidence(
    draft: EvidenceDraft,
    meta: AgentIdentity,
  ): Promise<unknown> {
    this.recordedRequests.push(meta);
    this.recordedSubmissions.push({ draft, meta });
    this.submissionCounter += 1;
    return {
      draftId: draft.id,
      marketId: draft.marketId,
      rationale:
        "Stub receipt: accepted (no live Delphi call — the stub never touches the network).",
      submissionId: `stub-submission-${this.submissionCounter}`,
      submittedAt: new Date().toISOString(),
      verdict: "accepted",
    };
  }
}
