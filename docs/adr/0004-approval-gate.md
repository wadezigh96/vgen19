# ADR-0004: Human approval gate for first submissions, then autonomous

Status: Accepted (20 November 2026)

## Context

Evidence quality decides rewards, and early submissions set the pattern for
the whole window. At the same time, the competition rewards speed: evidence
that repeats an earlier submission earns nothing, so waiting on a human for
every submission would lose races. Kames also wants approval before the agent
acts on his behalf in a live competition.

## Decision

Gate the first submissions behind human approval: Vgen19 drafts, Kames
reviews the drafts in dry-run reports, and only approved drafts are sent.
Once quality is calibrated, the agent runs autonomously within its guardrails
(submission caps, budgets, self-review rubric), and every cycle still
produces a report Kames reads afterwards. Kames can re-enable the gate at any
time.

## Consequences

- Quality is calibrated on real drafts before the agent spends the
  per-market submission budget.
- After calibration, the agent can move fast on newly opened markets without
  waiting for a human.
- The approval gate is a configuration flag, not a code fork, so it can be
  toggled per cycle.
