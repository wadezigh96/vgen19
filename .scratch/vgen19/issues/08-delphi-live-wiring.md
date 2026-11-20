# 08: Delphi live wiring (23 November)

**What to build:** Replace the adapter stub with the real Delphi API using
the official guide published when the competition opens on 23 November
(endpoints, authentication, submission format, one-line prompt), and prove it
with a live smoke test. No other module changes: the adapter boundary holds.

**Blocked by:** 07: Full mining cycle runner and reports; and the 23 November publication of the official guide (external).

**Status:** ready-for-agent

- [ ] The adapter implements the real market-list endpoint, submission endpoint, and receipt format from the official guide
- [ ] The official one-line prompt is adopted where the guide requires it
- [ ] Live smoke test: the market list reads real competition markets; the submission path is verified dry-run first, then with one approved live submission if Kames agrees
- [ ] Fixtures are updated from real responses (sanitized, no secrets)
- [ ] No module outside the adapter changes
