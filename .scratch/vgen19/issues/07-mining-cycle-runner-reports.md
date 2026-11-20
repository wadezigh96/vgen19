# 07: Full mining cycle runner and reports

**What to build:** One command runs a complete mining cycle: sync markets,
pick targets (preferring newly opened markets), research, draft, submit, read
receipts, and write a short Markdown report plus a JSONL trace. Re-running a
cycle never resubmits evidence, and an interrupted cycle loses no records.

**Blocked by:** 06: Submission, receipts, and rewards.

**Status:** ready-for-agent

- [ ] One command runs a full cycle end to end against fakes and writes a report (markets checked, drafts, submissions, receipts, rewards so far)
- [ ] Market picking prefers newly opened markets and skips fully covered ones
- [ ] A JSONL trace records every step; cost tracking records model and search calls per cycle
- [ ] Re-running a cycle never resubmits evidence (idempotent; memory is the source of truth)
- [ ] Interruption mid-cycle loses no submitted-evidence records (resume tested)
- [ ] Tests cover the full cycle with fakes, idempotency, and resume
