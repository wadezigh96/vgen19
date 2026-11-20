# 03: Market sync and memory store

**What to build:** The agent can read the competition market list through the
Delphi adapter (a stub with recorded fixtures until the official API is
published on 23 November) and persist markets in the memory store, so later
tickets can pick targets and remember what was already covered.

**Blocked by:** 01: Project scaffold and CI.

**Status:** ready-for-agent

- [ ] The market-list command shows markets with odds, close time, evidence cutoff, and reward pot (from fixtures for now)
- [ ] The memory store persists markets across runs (round-trip tested)
- [ ] The Delphi adapter boundary exists: only the adapter knows endpoints, authentication, and formats; the stub and fixtures stand in until 23 November
- [ ] Re-syncing updates changed markets without duplicating stored ones
- [ ] Tests cover sync, persistence round-trip, and dedup using fakes only
