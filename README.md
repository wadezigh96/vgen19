# Vgen19

Vgen19 is an evidence-mining agent for the Delphi Agent Competition 2
("Evidence Mining") on DoraHacks. In scheduled mining cycles it reads the
competition market list, researches the web for dated, sourced facts, drafts
short cited evidence notes, submits them to Delphi, and reports what was
submitted and what it earned. Rewards are paid in USDC.e when evidence makes
Delphi's forecaster more accurate, and again when a market settles the way
the evidence pointed.

The agent is built on a seven-part architecture (Brain, Context, Tools,
Memory, Patterns, Guardrails, Evals) and only ever uses free services: no
paid API calls, no trading, no wallet signing, no transactions. See
[docs/SPEC.md](docs/SPEC.md) for the full spec and
[GLOSSARY.md](GLOSSARY.md) for the shared vocabulary.

> Status: the agent is built — market sync, research, drafting with
> self-review, submission with receipts, human approval, cycle and
> final-summary reports, and scheduled runs all work against a stub
> Delphi adapter. The real Delphi API integration lands as one
> contained change on 23 November 2026, when the competition opens
> and the official API key, guide, and starter agent are published.
> Until then, no live Delphi integration exists yet.

## Quick start

Requirements: Node.js 20 or newer, npm.

```sh
npm install
npm test
```

## Scripts

| Command             | What it does                                  |
| ------------------- | --------------------------------------------- |
| `npm test`          | Run the Vitest test suite                     |
| `npm run build`     | Compile TypeScript to `dist/`                 |
| `npm run typecheck` | Type check without emitting files             |
| `npm run lint`      | Lint with ESLint                              |
| `npm run dev`       | Run the CLI from source (via `tsx`)           |
| `npm start`         | Run the compiled CLI from `dist/`             |

## CLI usage

```sh
npm run dev -- --help     # show help (from source)
npm start -- --help       # show help (compiled)
npm run dev -- markets    # sync the market list and show it
npm run dev -- markets --json  # same, as machine-readable JSON
npm run dev -- research <market-id>  # research one market, save its notes
npm run dev -- research <market-id> --json  # same, as machine-readable JSON
npm run dev -- draft <market-id>     # draft evidence for a researched market
npm run dev -- draft <market-id> --json  # same, as machine-readable JSON
npm run dev -- submit <draft-id>     # submit an approved draft to Delphi
npm run dev -- approve <draft-id>    # approve a draft for submission
npm run dev -- approve <draft-id> --note "ok"  # approve with a note
npm run dev -- mine       # run one full mining cycle and write its report
npm run dev -- summary    # aggregate the final summary and write its report
npm run dev -- summary --json  # same, as machine-readable JSON
```

Running with no arguments prints help and exits 0. An unknown command prints
help to stderr and exits non-zero. The `markets` command syncs the
competition market list through the Delphi adapter (a stub with recorded
fixtures until the official API is published on 23 November 2026) into the
memory store (`markets.json` under the data dir), then lists the stored
markets with odds, close time, evidence cutoff, and reward pot. Re-running
it updates changed markets without duplicating them.

The `research` command researches one stored market: it derives up to 3 search
queries from the market question, searches the web, reads the top source
pages, extracts dated factual claims with the extraction model, skips
findings already known for that market, and saves the notes
(`research-notes.json` under the data dir) for drafting. Run `vgen19
markets` first: an unknown market id fails with a clear message instead of
syncing silently. With no `TAVILY_API_KEY` set, research uses keyless
search (rate-limited); with neither a search key nor a model key, it fails
closed naming both variables.

Markets follow the real Delphi API shape: each market is identified by its
on-chain contract address, carries its question, outcomes, and resolution
criteria in parsed metadata, and has a status of `open`,
`awaiting_settlement`, `settled`, `expired`, or `failed`. The close time
shown is the metadata end date, falling back to the scheduled settlement
time when the metadata has no end date. Odds, evidence cutoff, and reward
pot are competition-2-only fields that the public Delphi docs do not
define; they live in an optional extension on the market, populated by
the competition endpoints in ticket 08, and show as `n/a` when a market
carries none.

The `mine` command runs one complete mining cycle (sync markets, pick
targets, research, draft, submit, read receipts, report) and prints a
one-paragraph summary. `mine --cycle <id>` runs under a given cycle id;
`mine --dry-run` drafts without submitting; `mine --json` prints the
cycle summary as JSON. The `summary` command aggregates the
end-of-competition final summary across all cycles (total submissions,
markets, rewards, best evidence, per-cycle table, failed cycles) and
writes `<data-dir>/final-summary.md`.

The `draft`, `submit`, and `approve` commands are the manual
equivalents of the cycle's middle steps. `draft <market-id>` drafts
evidence from a market's saved research notes, self-reviews it
against the rubric, and saves the draft (`drafts.json` under the
data dir); run `vgen19 research` first. `approve <draft-id>`
approves a draft for submission (optionally with `--note`); the
approval gate means the first submissions wait for a human. `submit
<draft-id>` submits an approved draft to Delphi, parses the receipt,
and records the submission and any reward; `submit --cycle <id>`
attributes the submission to a cycle.

## Scheduled runs and final summary

Mining cycles run as scheduled batch jobs on the Muse VM during the
competition window (ADR 0003), not as a 24/7 daemon. This repository
prepares the schedule; it creates no schedules itself. The main agent
installs it (for example as Muse cron jobs) from
`scripts/schedule.json`:

- Window: 23 November 2026 17:00 UTC to 11 December 2026 17:00 UTC.
- Two cycles per day, at 02:00 and 14:00 UTC (`morning`, `afternoon`).
- Command: `bash scripts/run-cycle.sh`.

The run script resolves the repo root, builds only if `dist/cli.js`
is missing (the main agent builds once at install time), fetches
fresh credential surrogates from authd at run start and passes them
as `GEMINI_API_KEY` / `TAVILY_API_KEY` to the agent process for that
run only, then runs one cycle and captures its output to a per-run
log under `<data-dir>/runs/<cycle-id>.log`. The real keys live in
the Muse Secure Vault and are never in a file, a log, or an
environment variable: the runtime swaps each `hsurr:` surrogate for
the real key on egress. A failed cycle never fails the script: the
failure is logged and recorded in `<data-dir>/runs/index.jsonl`, and
the script still exits 0 so the scheduler keeps running later
cycles. Each cycle is idempotent: re-running it never resubmits
evidence, because the memory store is the source of truth. Note:
generating content through the Gemini surrogate path is untested
(only list-models is verified through that connector), so the first
scheduled run must be watched and its log checked.

Quota math (free tiers only; the binding constraint is the
strong-model daily budget): Gemini free-tier rate limits are tight,
with reported values (not Google-published) of Flash ~5 RPM / ~20
requests per day and Flash-Lite ~15 RPM / ~500 requests per day.
Most work is routed to Flash-Lite (triage/extraction); drafting and
judging use the strong model (Flash). The per-cycle model-call
budget stays at 50, but the binding constraint is the ~20/day
strong-model budget: 2 cycles/day x ~10 strong calls (at most ~5
drafting + ~5 judging, at most 5 markets/cycle) = ~20/day, which
fits; a 3rd cycle/day would exceed it. Tavily: 1,000 credits/month,
basic search 1 credit; a cycle does at most 5 markets x 3 searches =
15 credits, so 2 cycles/day x 19 days x 15 credits is at most ~570
credits, inside budget.

When the window closes, `vgen19 summary` aggregates the final
summary from the memory store, the per-cycle cost records, the
traces, and the run index, and writes
`<data-dir>/final-summary.md` (in Indonesian, like the cycle
reports): total submissions with the accepted/judged/rejected
breakdown, markets covered, total rewards, the top 5 submissions by
judgment reward, a per-cycle table, and the cycles that failed or
left no record of completing.

## Ticket 08 follow-ups

These items wait for the official Delphi guide, published when the
competition opens on 23 November 2026. Nothing here is invented:
no endpoint, receipt shape, or leaderboard is guessed at.

- **Settlement rewards.** `recordSettlementReward` exists and is
  tested, but nothing calls it in production yet: the adapter has
  no reward/settlement query, and neither the runner nor the
  summary fetches settlement data. Ticket 08 wires the real
  settlement query and calls it from the runner or the summary.
- **OpenRouter fallback in scheduled runs.** Scheduled runs
  currently run WITHOUT the OpenRouter fallback: `run-cycle.sh`
  fetches only the Gemini and Tavily credential surrogates, so a
  Gemini outage kills the cycle (the interactive CLI falls back
  to OpenRouter when `OPENROUTER_API_KEY` is set, but the
  scheduled path has no key to fall back to). Adding it requires
  connecting an OpenRouter credential in the vault and extending
  `run-cycle.sh` to fetch its surrogate; the script carries a
  clearly-marked optional block for that, disabled until the
  connection exists.
- **Rank/leaderboard context.** The cycle report and final
  summary state that rank/leaderboard context is unavailable
  until the guide publishes; ticket 08 adds it once the
  leaderboard endpoint is known.

## Configuration

Configuration comes only from environment variables. Copy
`.env.example` to `.env` and fill in your own keys; `.env` is never
committed. Placeholder values only in `.env.example`.

| Variable                        | Required | Default    | What it is                                              |
| ------------------------------- | -------- | ---------- | ------------------------------------------------------- |
| `DELPHI_API_KEY`                | Live only | —         | Delphi API key, available 23 Nov 2026                   |
| `GEMINI_API_KEY`                | No       | —          | Google AI Studio key, default model provider (free)     |
| `GEMINI_FAST_MODEL`             | No       | `gemini-3.5-flash-lite` | Fast Gemini model: triage, extraction        |
| `GEMINI_STRONG_MODEL`           | No       | `gemini-3.8-flash` | Strong Gemini model: drafting, judging        |
| `OPENROUTER_API_KEY`            | No       | —          | OpenRouter key, fallback model provider (free models)   |
| `OPENROUTER_FAST_MODEL`         | No       | `nvidia/nemotron-3.5-lightning:free` | Fast fallback model: triage, extraction |
| `OPENROUTER_STRONG_MODEL`       | No       | `nvidia/nemotron-3-ultra-550b-a55b:free` | Strong fallback model: drafting, judging |
| `TAVILY_API_KEY`                | No       | —          | Tavily key, default search provider (free)              |
| `TAVILY_SEARCH_ENDPOINT`      | No       | `https://api.tavily.com/search` | Tavily search endpoint (verified 20 Nov 2026) |
| `VGEN19_MAX_SEARCHES_PER_MARKET` | No    | `3`        | Max search queries per market in one research run       |
| `VGEN19_MAX_PAGES_PER_MARKET` | No       | `5`        | Max source pages read per market in one research run    |
| `VGEN19_MAX_MODEL_CALLS_PER_MARKET` | No | `6`        | Max model calls per market in one research run          |
| `VGEN19_NOTES_CHAR_BUDGET`    | No       | `8000`     | Context budget for research notes, in characters        |
| `VGEN19_DATA_DIR`               | No       | `./data`   | Directory for long-term JSON storage                    |
| `VGEN19_APPROVAL_GATE`          | No       | `true`     | First submissions wait for human approval               |
| `VGEN19_DRY_RUN`                | No       | `false`    | Draft evidence without submitting anything              |
| `VGEN19_REVIEW_PASS_THRESHOLD`  | No       | `0.7`      | Self-review pass threshold for the overall rubric score |
| `VGEN19_MAX_MARKETS_PER_CYCLE`  | No       | `5`        | Max markets worked in one mining cycle                  |
| `VGEN19_MAX_SUBMISSIONS_PER_CYCLE` | No    | `5`        | Max submissions sent in one mining cycle                |
| `VGEN19_MODEL_CALL_BUDGET`      | No       | `50`       | Max model calls allowed in one mining cycle             |
| `VGEN19_CYCLE_TIME_BUDGET_MINUTES` | No    | `45`       | Per-cycle time budget in minutes; the runner stops picking new markets once it passes |

Model IDs were verified against current documentation on 20 November
2026 (see the note in `src/config.ts` for sources). Free models rotate,
so if a default stops working, set the matching variable to a current
free ID: any Gemini ID for the Gemini variables, and any ID ending in
`:free` (or `openrouter/free`) for the OpenRouter variables. The
OpenRouter provider refuses non-free IDs outright, so a bad value can
never turn into a paid call.

### Model providers

All model access goes through one interface (`ModelProvider`: chat
completion plus structured JSON output) behind the routed client
(`createRoutedClient`, built from `loadConfig` output). Routing sends
triage and extraction to the fast model and drafting and judging to
the stronger model. The default provider is Gemini (Google AI Studio
free tier, `generateContent` endpoint); on any failure the client
automatically tries the OpenRouter fallback once, then fails closed
with both errors named. No retries, no paid tier.

Every model call consumes one unit of the per-cycle budget
(`VGEN19_MODEL_CALL_BUDGET`, default 50), checked before the call is
made; when it is exhausted the client throws `BudgetExhaustedError`
and makes no further calls. The count resets only when a new client
is created for the next mining cycle. Structured JSON output is
parsed and validated against a caller-supplied schema before it is
returned; malformed JSON or a schema mismatch throws
`JsonValidationError` instead of returning unvalidated output.

Tests use `FakeModelProvider` (scripted responses, scripted failures,
call recording) and stubbed `fetch`; no test touches the live network.

### Search providers

All web search goes through one interface (`SearchProvider`). The default
is the Tavily free tier (Researcher plan: 1,000 API credits a month, no
card, resetting on the 1st); on any failure the client tries the keyless
fallback once (Tavily keyless mode on the same endpoint, free and
rate-limited), then fails closed naming both errors. No retries, no paid
tier.

Tavily facts verified 20 November 2026 against docs.tavily.com and
multiple 2026 sources: endpoint `POST https://api.tavily.com/search`
(configurable via `TAVILY_SEARCH_ENDPOINT`, verified value as default);
auth is the `Authorization: Bearer <key>` header (the `api_key` body
field is legacy and is not used; `X-Api-Key` is wrong); keys start with
`tvly-` and come from app.tavily.com; basic depth costs 1 credit a
search and advanced costs 2, so the provider always sends basic depth
explicitly; results carry `title`, `url`, `content` (mapped to the
snippet), `score`, and `published_date` (mapped to the finding date when
present). Sources: docs.tavily.com SDK reference, troiana.net Tavily
guide, twitterapi.io Tavily guide, scispace.com Tavily guide, cors.dev
free search API comparison (which live-tested keyless mode in October
2026). DuckDuckGo's HTML endpoint was checked and deliberately not used
as the fallback: it is an unofficial scraping surface with bot-blocking
that changed in February 2026.

### Research loop

`researchMarket` runs the bounded per-market loop: derive up to 3 search
queries from the question (deterministic, no model call), search, read
the top pages (10-second timeout each), extract dated factual claims
with the extraction model, skip findings already known for the market,
and assemble research notes. Bounds per market: 3 searches, 5 pages,
6 model calls, 8,000-character notes budget (all configurable, see the
table above). A failed page fetch or extraction is recorded in the
notes as a failed source, never fatal; only a total search failure
throws. Notes over budget are compacted before drafting: the model
summarizes them, the result is validated to carry every claim and
source link, and any failure falls back to deterministic compaction
(drop quotes first). Fetched web content is untrusted data: the
extraction prompt says so, instruction-like claims are dropped, and the
researcher never acts on page content. Tests cover the loop with fake
search, reader, and model only.

### Fail-closed behavior

Missing optional keys do not fail at startup. Instead, the code that needs
a key calls `requireKey` at the point of use, which throws a clear error
naming the missing variable (for example,
`Missing required environment variable: DELPHI_API_KEY`). The agent never
runs a live step without the key that step needs. Invalid values (a
non-boolean flag, a non-positive limit) fail at load time with an error
naming the variable.

## Project layout

```text
src/
  index.ts    Public API re-exports
  agent.ts    Agent-wide constants (agent name)
  cli.ts      CLI entry point and command registry
  commands/   CLI subcommand handlers (markets, research, draft, submit, mine, summary)
  config.ts   Environment-based configuration
  cycle/      Mining cycle runner, market picking, trace, costs, report
  delphi/     Delphi adapter boundary (interface, stub, fixtures, sync)
  draft/      Evidence drafting, validation, self-review judge
  llm/        Brain: model providers, routing, per-cycle budget
  memory/     Long-term JSON memory store
  research/   Researcher loop, notes, compaction, page reader
  search/     Search providers (Tavily, keyless fallback, fake)
  submit/     Submission, receipts, rewards, approvals, refusals
  summary/    Final summary aggregator, run index reader, report
scripts/      Scheduled-run script, schedule definition, surrogate helper
test/         Vitest tests (one file per module)
docs/         Spec and architecture decision records
```

## Continuous integration

GitHub Actions (`.github/workflows/ci.yml`) runs build, type check, tests,
and lint on every push and pull request, on Node.js 20.x.
