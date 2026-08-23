# Gates: leaf 1.3.3 — Cross-dataset v_customers draft

OWNS: src/enrichment/mappings/customers.ts, test/enrichment/mappings/customers.test.ts

Scope: v_customers view joining normalized contact columns across CRM datasets
by exact email key only (deterministic anchors; no fuzzy logic in Phase 1).

- [x] G1: v_customers suite passes (same-email union across two fixtures; disjoint emails stay separate)
  CHECK: pnpm vitest run test/enrichment/mappings/customers.test.ts && echo customers-view-green
  EXPECT: customers-view-green
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/divyansh/Stratiki; path=a581e1b26f25/22 entries; output=(node:56056) ExperimentalWarning: SQLite is an experimental feature and might change at any time | (Use `node --trace-warnings ...` to show where the warning was created)
