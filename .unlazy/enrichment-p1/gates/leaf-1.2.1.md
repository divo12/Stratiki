# Gates: leaf 1.2.1 — Mapping schema + store methods

OWNS: src/book/view-mappings.ts, test/enrichment/views/view-mappings.test.ts

Scope: `view_mappings` table (additive CREATE IF NOT EXISTS in book.db) plus
ViewMappingStore with setMapping/getMappingsForDataset/clearDataset; rows are
the single input to the emitter — no inline SQL anywhere else.

- [x] G1: store suite passes (upsert, list-by-dataset, clear; survives reopen)
  CHECK: pnpm vitest run test/enrichment/views/view-mappings.test.ts && echo mapping-store-green
  EXPECT: mapping-store-green
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/divyansh/Stratiki; path=a581e1b26f25/22 entries; output=(node:53343) ExperimentalWarning: SQLite is an experimental feature and might change at any time | (Use `node --trace-warnings ...` to show where the warning was created)
