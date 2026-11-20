# 02: Free-tier model provider and routing (Brain)

**What to build:** The agent's Brain: one model-provider interface with chat
completion and structured JSON output, a free-tier default provider, a
free-tier fallback provider, and routing that sends cheap work (triage,
extraction) to a fast model and expensive work (drafting, judging) to a
stronger model, all under a per-cycle call budget. The agent must never call
a paid tier.

**Blocked by:** 01: Project scaffold and CI.

**Status:** ready-for-agent

- [ ] Provider interface supports chat completion and structured JSON output; a fake provider exists for tests
- [ ] Default free-tier provider and fallback free-tier provider are both implemented; the fallback engages automatically when the default fails
- [ ] Routing sends triage and extraction to the fast model and drafting and judging to the stronger model
- [ ] Per-cycle call budget is enforced: exceeding it stops model calls cleanly, with no retries and no paid calls
- [ ] Tests cover fallback, routing, budget enforcement, and JSON validation using fakes only (no live network)
