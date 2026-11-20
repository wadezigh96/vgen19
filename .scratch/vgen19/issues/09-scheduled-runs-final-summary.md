# 09: Scheduled runs and final summary

**What to build:** Mining cycles run on a schedule during the competition
window, and the competition ends with a final summary report. The schedule is
prepared here; the main agent installs it.

**Blocked by:** 07: Full mining cycle runner and reports.

**Status:** ready-for-agent

- [ ] A run script plus a schedule definition exist for repeated cycles during 23 November to 11 December (prepared for the main agent to install; this ticket creates no schedules itself)
- [ ] The schedule respects free-tier quotas (cycles per day tuned to budgets)
- [ ] A final summary report aggregates total submissions, markets, rewards, and best evidence
- [ ] Failure of one scheduled cycle does not stop later cycles; failures are reported
