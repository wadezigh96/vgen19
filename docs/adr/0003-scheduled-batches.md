# ADR-0003: Scheduled batch runs on the Muse VM, no daemon

Status: Accepted (20 November 2026)

## Context

The mining window runs 23 November to 11 December. Kames has no server and
works from a phone, so the agent cannot run on his devices. It needs to run
repeatedly without him watching it.

## Decision

Run Vgen19 as scheduled batch jobs (mining cycles) on the Muse VM, driven by
the runtime's scheduler. No 24/7 daemon process. Each cycle is idempotent:
re-running it never resubmits evidence, because the memory store is the
source of truth for what was already submitted.

## Consequences

- No server to provision, pay for, or keep alive; the VM's home directory
  persists the memory store across runs.
- A missed or failed cycle loses at most one batch of mining, and the next
  cycle resumes from stored memory.
- Run cadence is a configuration choice (a few cycles per day), tunable
  against free-tier quotas and market freshness.
