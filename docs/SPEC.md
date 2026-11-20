# Vgen19 — Spec: Delphi Evidence-Mining Agent

## Problem Statement

Kames is registered for the Delphi Agent Competition 2 ("Evidence Mining") on
DoraHacks. In this competition, an agent earns real USDC rewards by finding
sourced, dated facts about live Delphi prediction markets and submitting them
as evidence through the Delphi API. Rewards are paid when the evidence makes
Delphi's forecaster more accurate, and again when the market settles the way
the evidence pointed. The agents with the most total rewards share a $7,250
prize pool.

Kames has no agent yet, no budget for paid APIs, no server, and works only
from his phone. The competition opens on 23 November 2026 and the mining
window runs until 11 December 2026. He needs an agent that is built for him,
runs on a schedule without him watching it, only ever uses free services, and
reports back in plain Indonesian. To qualify for prizes, the agent must
produce at least 10 judged submissions across at least 3 markets.

## Solution

Vgen19 is an evidence-mining agent that lives in this repository. It runs in
scheduled mining cycles. Each cycle it reads the competition market list,
picks the markets where it can add something new, researches the web for
dated and sourced facts, drafts short cited evidence notes, submits them to
Delphi, checks the receipts, and records the rewards. Every cycle produces a
short report so Kames can see what was submitted and what it earned.

Vgen19 is built on the seven-part agent architecture: Brain, Context, Tools,
Memory, Patterns, Guardrails, and Evals. Each part maps to a concrete piece of
the agent (see Implementation Decisions). The Delphi API integration is kept
behind one adapter boundary, because the official endpoints, authentication,
and submission format are only published when the competition opens on
23 November; until then the agent builds against a stub and recorded fixtures.

## User Stories

1. As Kames, I want the agent to read the competition market list (odds, close
   time, evidence cutoff, reward pot) so that I can see where mining is worth
   the effort.
2. As Kames, I want the agent to pick markets where it can add something new
   instead of markets it already covered, so that effort goes where rewards
   are possible.
3. As Kames, I want the agent to prefer newly opened markets, so that its
   evidence arrives before anyone else submits the same facts.
4. As Vgen19, I want to search the web for dated, sourced facts about a market
   question, so that my evidence is grounded in public information.
5. As Vgen19, I want to read full source pages, not just search snippets, so
   that the facts I submit are accurate and checkable.
6. As Vgen19, I want to keep research notes per market with source links and
   dates, so that drafting and later review can trace every claim.
7. As Vgen19, I want to draft evidence as a short note with links, in the
   exact shape the Delphi API accepts, so that submissions are never rejected
   for formatting.
8. As Vgen19, I want to check my own draft against a quality rubric (sourced,
   dated, novel, relevant, no invented facts) before submitting, so that weak
   drafts never reach the judge.
9. As Kames, I want to approve the first few submissions before they go out,
   so that I can calibrate quality before the agent runs on its own.
10. As Kames, I want the agent to run on its own within fixed limits after
    calibration, so that it keeps mining while I am away.
11. As Vgen19, I want to send my agent name, harness, and model with every
    request, so that my results show under my name on the leaderboard.
12. As Vgen19, I want to submit at most 3 pieces of evidence per market, so
    that I never break the competition rule.
13. As Vgen19, I want to remember every fact I already submitted per market,
    so that I never submit a repeat that earns nothing.
14. As Vgen19, I want to remember facts other submissions already covered when
    that is knowable, so that I aim for novelty.
15. As Vgen19, I want to read the receipt for every submission (verdict,
    rationale, reward) within minutes, so that I know what worked.
16. As Kames, I want a short report after every mining cycle (markets checked,
    evidence submitted, receipts, rewards so far), so that I always know where
    we stand without reading logs.
17. As Kames, I want to see total rewards and rank context in the report, so
    that I know whether we are on track for the prizes.
18. As Vgen19, I want to record every reward (judgment and settlement) against
    the submission that earned it, so that later analysis can tell which kinds
    of evidence pay.
19. As Vgen19, I want a dry-run mode that drafts evidence without submitting,
    so that Kames and I can review quality safely.
20. As Kames, I want the agent to never spend money: no paid API calls, no
    trading, no wallet signing, no transactions, so that competing costs me
    nothing.
21. As Kames, I want the agent to stop cleanly when a free-tier limit is hit
    instead of retrying forever, so that a limit never turns into a bill or a
    ban.
22. As Vgen19, I want a per-cycle budget (time, model calls, submissions) that
    I cannot exceed, so that a bad run cannot spiral.
23. As Vgen19, I want to treat everything fetched from the web as untrusted
    data, never as instructions, so that a hostile page cannot hijack the
    agent.
24. As Vgen19, I want to validate every draft against a strict shape before
    submitting, so that malformed output never leaves the agent.
25. As Kames, I want a trace log of every step the agent took in a cycle, so
    that any bad submission can be explained afterwards.
26. As Kames, I want the agent's running cost tracked per cycle (model calls,
    tokens, search calls), so that I can see the competition is really free.
27. As Vgen19, I want to resume a cycle from stored memory after an
    interruption, so that a crash does not lose submitted-evidence records.
28. As Kames, I want the agent to use a stronger model only for drafting and
    judging, and a cheaper model for triage and extraction, so that free-tier
    quotas last the whole window.
29. As Vgen19, I want to fall back to a second free model provider when the
    first is unavailable, so that one outage does not kill a mining day.
30. As Kames, I want the Delphi wiring (endpoints, key, submission format) to
    land as one contained change on 23 November, so that the rest of the agent
    does not need rework when the official guide appears.
31. As Kames, I want an end-of-competition summary (total submissions,
    markets, rewards, best evidence), so that the run is recorded even after
    the window closes.

## Implementation Decisions

- Stack: TypeScript on Node.js LTS, npm, strict type checking, Vitest for
  tests, GitHub Actions for continuous integration.
- The agent is organized by responsibility into these modules: a runner that
  owns the mining cycle and the command-line interface; a market client that
  talks to Delphi behind one adapter boundary; a search provider and a page
  reader for web research; a researcher that runs the observe-search-read-
  assess loop per market; a drafter that produces structured evidence; a
  self-review judge that scores drafts against the quality rubric; a submitter
  that sends evidence and reads receipts; a memory store that persists markets,
  submissions, receipts, rewards, and known facts; a policy module that
  enforces all limits; a tracer that logs every step; a reporter that writes
  the per-cycle report; and configuration that reads only from environment
  variables.
- Seven-part architecture mapping:
  - Brain: a language-model provider interface with chat completion and
    structured JSON output; model routing sends triage and extraction to a
    fast free model and drafting and judging to a stronger free model.
  - Context: a system prompt stating the evidence-mining persona and rules;
    retrieval over the current run's fetched sources; a per-market context
    budget with truncation; compaction that summarizes long research notes
    before drafting.
  - Tools: web search, page fetch and read, the Delphi market and submission
    client, and local draft file handling. No shell execution of untrusted
    content anywhere.
  - Memory: short-term working memory inside one run; long-term JSON storage
    across runs for markets, submissions, receipts, rewards, and known facts;
    per-market summaries kept small and current.
  - Patterns: a ReAct loop per market (observe, search, read, assess, draft,
    submit, check receipt); plan-and-execute per cycle (pick markets, then
    work them in order); parallel research across markets within one cycle;
    human-in-the-loop approval for the first submissions, then autonomous
    operation within guardrails.
  - Guardrails: read-only web access plus Delphi submission only; no trading,
    no wallet access, no signing, no spending; submission caps per market and
    per cycle; time and model-call budgets per cycle; prompt-injection
    handling that treats fetched content as data; strict output validation;
    fail-closed behavior when a key or a service is missing.
  - Evals: a golden set of markets with known outcomes for offline draft
    checks; LLM-as-judge self-review before every submission; a JSONL trace
    of every step; cost tracking per cycle and reward tracking per submission.
- Language-model providers are pluggable behind one interface. The default is
  a free tier (Google AI Studio Gemini); the fallback is a second free tier
  (OpenRouter free models). The agent must never call a paid tier, and it must
  degrade to fewer markets rather than exceed a free quota.
- Search is pluggable behind one interface. The default is a free search tier
  (Tavily free tier); the fallback is a keyless web search. Search results are
  treated as leads; facts are only used after reading the source page.
- The Delphi adapter is the only module that knows Delphi endpoints,
  authentication, and the submission format. Until the official guide is
  published on 23 November, it runs against a stub with recorded fixtures, and
  the wiring lands as one contained change. The agent sends its name (Vgen19),
  harness, and model with requests, per the competition instructions.
- Evidence drafts are validated against a strict shape (short note, links,
  optional files) before submission, and any draft that fails validation or
  self-review is kept for reporting instead of being sent.
- Duplicate protection works on two levels: the memory store records every
  submitted fact per market (normalized text plus source URL), and the
  researcher checks new findings against those records before drafting.
- Scheduling: mining cycles run as scheduled batch jobs on the Muse VM during
  the window, not as a 24/7 daemon. Each cycle is idempotent: re-running it
  never resubmits evidence, because the memory store is the source of truth.
- Configuration comes only from environment variables; secrets are never
  committed, logged, or printed. A sanitized example file documents every
  variable.
- Reports are Markdown files, one per cycle, plus a running summary. The
  report is the primary surface Kames reads; logs exist for debugging only.

## Testing Decisions

- Vitest is the test runner. Tests check external behavior (what a module
  returns or records), not implementation details.
- Unit tests cover: policy limits (per-market and per-cycle submission caps,
  budgets), duplicate detection, draft validation, self-review scoring,
  memory store round-trips, and receipt parsing.
- Integration tests run the researcher and submitter against in-memory fakes
  (fake model, fake search, fake Delphi API). No test touches the live network
  or a real API key.
- A golden eval set of a small number of markets with known outcomes is used
  to check draft quality offline; the rubric is the same one the self-review
  judge applies.
- Dry-run mode is covered by tests proving that a full cycle in dry-run mode
  records drafts and never calls submit.
- Continuous integration runs build, type check, tests, and lint on every
  push.

## Out of Scope

- Trading on Delphi markets, and anything that signs, sends, or spends: no
  wallet access, no transactions, no paid services of any kind.
- A 24/7 daemon or a hosted web dashboard. Version one is scheduled batch
  runs plus Markdown reports.
- Exposing Vgen19's tools as an MCP server for other agents. This is a
  stretch goal after core mining works.
- Paid model or search tiers, and research in languages other than English
  (competition markets are in English; reports to Kames are in Indonesian).
- Multi-user or team features, and any mobile app.

## Further Notes

- Timeline: spec 20 November 2026; build 21-22 November; Delphi wiring on
  23 November when the API key, official guide, and starter agent are
  published; mining 23 November to 11 December; winners announced 16 December.
- Open unknowns until 23 November: Delphi API base URL, authentication
  scheme, market-list endpoint, submission endpoint and payload format,
  receipt format, and the official one-line prompt. The adapter boundary and
  fixtures isolate all of them; the starter agent will be reviewed before the
  wiring change lands.
- Human steps needed from Kames: create a Delphi account with the registered
  wallet and take the API key (23 November); create a free model API key; create
  a free search API key. Each step gets a short numbered guide when its time
  comes.
- Risks: free-tier fragility (mitigated by provider fallback and degraded
  mode); duplicate evidence (mitigated by memory dedup and freshness
  preference); late arrival on a market (mitigated by prioritizing newly
  opened markets); prompt injection from web sources (mitigated by treating
  fetched content as data and validating outputs); the Delphi API differing
  from expectations (mitigated by the adapter boundary and a 23 November
  review of the official guide).
- No project issue tracker is configured for this repository, so this spec
  lives in the repo and progress is tracked through the Muse goal record for
  the competition. Tickets derived from this spec are produced by the
  to-tickets step and worked from the repo.
