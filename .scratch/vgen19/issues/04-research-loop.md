# 04: Research loop for one market

**What to build:** For a single market, the agent searches the web, reads
source pages, and produces sourced research notes with links and dates,
skipping facts already known for that market. Fetched web content is treated
as untrusted data, never as instructions.

**Blocked by:** 02: Free-tier model provider and routing; 03: Market sync and memory store.

**Status:** ready-for-agent

- [ ] The research command for one market produces notes with dated facts and source links
- [ ] Search uses the pluggable provider (free-tier default, keyless fallback)
- [ ] The page reader extracts readable text from source pages; a failed fetch is recorded, not fatal
- [ ] Findings already in memory for that market are skipped (dedup)
- [ ] Long notes are compacted to a summary before drafting (context budget respected)
- [ ] A test proves an instruction embedded in a fetched page is not followed
- [ ] Tests cover the loop with fake search, reader, and model (no live network)
