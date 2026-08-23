# Gates: leaf 1.4.1 — End-to-end ingest→admit→query fixture

OWNS: test/enrichment/integration/e2e.test.ts

Scope: seed temp book.db with fixture episodes through EpisodeStore.admit,
apply stripe+zendesk mappings, query the resulting views and v_customers;
assert row shapes, event-time ordering, and dedup on replayed admission.

- [x] G1: e2e suite passes
  CHECK: pnpm vitest run test/enrichment/integration/e2e.test.ts && echo e2e-green
  EXPECT: e2e-green
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/divyansh/Stratiki; path=a581e1b26f25/22 entries; output=(node:56725) ExperimentalWarning: SQLite is an experimental feature and might change at any time | (Use `node --trace-warnings ...` to show where the warning was created)
