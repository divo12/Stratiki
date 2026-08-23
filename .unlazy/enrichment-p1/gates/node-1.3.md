# Gates: branch 1.3 — Dataset mappings (integration)

OWNS: (verification-only)

Scope: registered mappings compile into queryable views for all seven
record-level datasets and the cross-dataset customer draft view.

- [x] N1.3.1: mapping suites pass
  CHECK: pnpm vitest run test/enrichment/mappings/ && echo mappings-green
  EXPECT: mappings-green
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/divyansh/Stratiki; path=a581e1b26f25/22 entries; output=(node:54241) ExperimentalWarning: SQLite is an experimental feature and might change at any time | (Use `node --trace-warnings ...` to show where the warning was created)

- [x] N1.3.2: children ledgers reverified clean
  CHECK: node ~/.claude/skills/unlazy/scripts/gate-check.mjs --status .unlazy/enrichment-p1/gates/leaf-1.3.1.md .unlazy/enrichment-p1/gates/leaf-1.3.2.md .unlazy/enrichment-p1/gates/leaf-1.3.3.md && echo mapping-children-current
  EXPECT: mapping-children-current
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/divyansh/Stratiki; path=a581e1b26f25/22 entries; output=ALL MET (3 met) | mapping-children-current
