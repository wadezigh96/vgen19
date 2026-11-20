# ADR-0001: TypeScript, Node.js, and Vitest

Status: Accepted (20 November 2026)

## Context

Vgen19 needs a stack the team can build and debug quickly before the mining
window opens on 23 November, and one that fits the Delphi ecosystem.

## Decision

Build Vgen19 in TypeScript on Node.js LTS with npm, strict type checking,
and Vitest for tests. Run build, type check, tests, and lint in GitHub
Actions on every push.

## Consequences

- The team already ships TypeScript agents and CLIs (Skelsol, Xaverus), so
  the build starts from familiar ground.
- The Delphi SDK from the previous competition is TypeScript/Node, so any
  official client code drops in without a language bridge.
- Strict types plus Vitest give the guardrail-heavy parts (policy caps,
  dedup, validation) fast, deterministic tests.
