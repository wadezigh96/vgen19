# 06: Submission, receipts, and rewards

**What to build:** The agent sends approved drafts to Delphi (through the
adapter stub until 23 November), reads each receipt (verdict, rationale,
reward), records rewards per submission, and enforces the human approval gate
and the submission caps.

**Blocked by:** 03: Market sync and memory store; 05: Evidence drafting, self-review, and dry run.

**Status:** ready-for-agent

- [ ] Submit sends only approved drafts through the adapter; receipts are parsed and stored per submission
- [ ] The per-market cap (3) and the per-cycle cap are enforced; attempts beyond caps are refused and reported
- [ ] Approval gate: when enabled, nothing is sent without approval; the gate is a configuration flag
- [ ] Rewards (judgment and settlement) are recorded against the submission that earned them
- [ ] The agent name, harness, and model are sent with requests
- [ ] Tests cover caps, the gate, receipt parsing, and reward recording with a fake Delphi API
