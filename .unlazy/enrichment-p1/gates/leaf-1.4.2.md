# Gates: leaf 1.4.2 — Docs + root reverify

OWNS: src/enrichment/README.md, test/enrichment/docs.test.ts

Scope: README documents registry API, mapping schema, view naming contract;
docs test asserts every documented export exists at runtime (no doc drift).

- [x] G1: docs drift test passes
  CHECK: pnpm vitest run test/enrichment/docs.test.ts && echo docs-green
  EXPECT: docs-green
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/divyansh/Stratiki; path=a581e1b26f25/22 entries; output=(node:56739) ExperimentalWarning: SQLite is an experimental feature and might change at any time | (Use `node --trace-warnings ...` to show where the warning was created)
