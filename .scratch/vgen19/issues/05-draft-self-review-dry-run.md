# 05: Evidence drafting, self-review, and dry run

**What to build:** The agent turns research notes into a validated evidence
draft, scores it against the quality rubric (sourced, dated, novel, relevant,
no invented facts), and can run a full dry-run cycle that drafts without ever
submitting.

**Blocked by:** 04: Research loop for one market.

**Status:** ready-for-agent

- [ ] The draft command produces evidence in the exact submission shape (short note plus links), strictly validated
- [ ] Self-review scores drafts against the rubric; weak drafts are kept and reported, never sent
- [ ] Dry-run mode runs research plus drafting end to end, and a test proves submit is never called in dry-run mode
- [ ] Drafts and scores are recorded in memory for reporting
- [ ] Tests cover validation failures, rubric scoring, and the dry-run guarantee using fakes only
