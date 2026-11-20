# 01: Project scaffold and CI

**What to build:** A green TypeScript project skeleton that every later ticket
builds on: strict TypeScript, Vitest, lint, GitHub Actions CI, environment-based
configuration with a sanitized example, and a command-line entry point that
prints help. A fresh clone can install dependencies and get a green test run.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] Fresh install followed by the test command passes (at least a smoke test)
- [ ] Build (type check) and lint pass
- [ ] CI runs build, type check, tests, and lint on push, and is green
- [ ] Configuration reads only from environment variables; missing keys fail closed with a clear message; the example env file documents every variable
- [ ] The CLI entry point prints help and exits 0
