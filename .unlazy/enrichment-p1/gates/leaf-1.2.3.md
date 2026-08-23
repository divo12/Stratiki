# Gates: leaf 1.2.3 — View lifecycle

OWNS: src/enrichment/views/lifecycle.ts, test/enrichment/views/lifecycle.test.ts

Scope: applyDatasetView(db, mappings) creates/replaces atomically per version
bump and drops stale views whose dataset disappeared; idempotent re-run is a
no-op.

- [x] G1: lifecycle suite passes (create, replace-on-version-bump, drop-stale, idempotence)
  CHECK: pnpm vitest run test/enrichment/views/lifecycle.test.ts && echo lifecycle-green
  EXPECT: lifecycle-green
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/divyansh/Stratiki; path=a581e1b26f25/22 entries; output=(node:53404) ExperimentalWarning: SQLite is an experimental feature and might change at any time | (Use `node --trace-warnings ...` to show where the warning was created)
