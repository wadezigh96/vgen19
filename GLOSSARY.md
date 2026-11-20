# Glossary

Shared vocabulary for the Vgen19 project. Use these words with these meanings
in specs, tickets, code, and reports.

- **Delphi**: Gensyn's on-chain information market protocol. Its markets ask
  real-world Yes/No questions. Not to be confused with the game Genshin.
- **Gensyn**: the project behind Delphi. Vgen19 competes in a Gensyn/Delphi
  competition, not anything related to Genshin Impact.
- **Market**: one Yes/No question on Delphi (politics, economics, sports,
  crypto, technology, current events). Each market has odds, a close time, an
  evidence cutoff, and a reward pot.
- **Forecaster**: Delphi's AI system that predicts market outcomes. Evidence
  earns rewards by making it more accurate.
- **Evidence**: a dated, sourced fact (or small set of facts) submitted about
  one market: a short note plus links and up to 3 files.
- **Submission**: one evidence delivery to Delphi for one market. At most 3
  submissions per market are allowed.
- **Judgment reward**: the reward fixed when a submission is judged, paid when
  the evidence moves the forecaster. Paid in USDC.e about 24 hours later.
- **Settlement reward**: an additional reward when a market settles and the
  evidence pointed toward the actual outcome.
- **Receipt**: the verdict, rationale, and reward returned for a submission,
  usually within minutes.
- **Leaderboard**: the competition ranking by total rewards (judgment plus
  settlement) on competition markets.
- **Mining cycle**: one scheduled run of Vgen19: sync markets, pick targets,
  research, draft, submit, read receipts, report.
- **Draft**: an evidence note prepared by Vgen19 but not yet submitted. Drafts
  that fail validation or self-review stay drafts and are reported, never sent.
- **Harness**: the program that runs the agent (here: the Vgen19 codebase
  itself). The agent sends its name, harness, and model with requests.
- **LMSR**: Logarithmic Market Scoring Rule, the automated market maker that
  sets Delphi market prices. Vgen19 reads prices; it never trades.
- **USDC.e**: the bridged USDC token rewards are paid in.
- **Agent name**: the registered competitor name, `Vgen19`, shown on the
  leaderboard.
- **Cutoff**: a market's evidence cutoff time. Evidence submitted after it does
  not count.
- **Dry run**: a mining cycle that drafts evidence without submitting anything.
- **Golden set**: a small set of markets with known outcomes used to check
  draft quality offline.
