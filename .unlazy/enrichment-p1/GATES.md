# Gates: Enrichment Phase 1 (root integration)

OWNS: (verification-only ledger; this node writes no source paths)

Scope: prove the whole enrichment Phase 1 surface — normalizers, mapping
store, emitted views, dataset mappings, and end-to-end episode→view query —
after every branch is VERIFIED.

- [x] R1: full enrichment suite passes
  CHECK: pnpm vitest run test/enrichment/ && echo enrichment-suite-green
  EXPECT: enrichment-suite-green
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/divyansh/Stratiki; path=a581e1b26f25/22 entries; output=(node:57422) ExperimentalWarning: SQLite is an experimental feature and might change at any time | (Use `node --trace-warnings ...` to show where the warning was created)

- [x] R2: repository typecheck stays clean with enrichment sources present
  CHECK: pnpm run typecheck && echo root-typecheck-ok
  EXPECT: root-typecheck-ok
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/divyansh/Stratiki; path=a581e1b26f25/22 entries; output=> tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.client.json | root-typecheck-ok

- [x] R3: no regression in existing connector, book, and ingestion suites
  CHECK: pnpm vitest run test/connectors/ test/book/ test/ingestion/ && echo regressions-green
  EXPECT: regressions-green
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/divyansh/Stratiki; path=a581e1b26f25/22 entries; output=(node:58271) ExperimentalWarning: SQLite is an experimental feature and might change at any time | (Use `node --trace-warnings ...` to show where the warning was created)

- [x] R4: docs describe the registry and view naming contract accurately
  EVIDENCE: reviewed src/enrichment/README.md against runtime surface on 2026-08-24; docs-drift test (test/enrichment/docs.test.ts) mechanically asserts every documented export exists and every FieldKind plus the v_stripe_stripe_events naming example appear verbatim.
