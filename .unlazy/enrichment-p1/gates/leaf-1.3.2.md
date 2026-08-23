# Gates: leaf 1.3.2 — Aggregate dataset mappings

OWNS: src/enrichment/mappings/aggregates.ts, test/enrichment/mappings/aggregates.test.ts

Scope: typed mappings for google-ads/google-ads-performance,
meta-ads/meta-insights, google-analytics/ga4-report rows.

- [x] G1: aggregate mapping suite passes
  CHECK: pnpm vitest run test/enrichment/mappings/aggregates.test.ts && echo aggregate-mappings-green
  EXPECT: aggregate-mappings-green
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/divyansh/Stratiki; path=a581e1b26f25/22 entries; output=(node:54213) ExperimentalWarning: SQLite is an experimental feature and might change at any time | (Use `node --trace-warnings ...` to show where the warning was created)
