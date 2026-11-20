# ADR-0002: Pluggable free-tier model providers with fallback

Status: Accepted (20 November 2026)

## Context

Kames has no budget: every model call must be free. Free tiers are fragile
(rate limits, retired endpoints, daily caps), and a single-provider design
would leave mining days dead on an outage. A previous Delphi competitor's
notes record exactly this failure mode.

## Decision

Put all model access behind one provider interface (chat completion plus
structured JSON output). Default to a free tier (Google AI Studio Gemini);
fall back to a second free tier (OpenRouter free models) when the first is
unavailable. Route cheap work (triage, extraction) to a fast model and
expensive work (drafting, judging) to a stronger model. Never call a paid
tier; degrade to fewer markets instead of exceeding a free quota.

## Consequences

- One outage cannot kill a mining day, and a retired endpoint costs a
  provider swap, not a rewrite.
- The provider interface is a seam the tests use with an in-memory fake, so
  no test needs a real key or the network.
- Quota handling becomes a first-class behavior (budgets, degraded mode)
  rather than an afterthought.
