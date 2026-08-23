# Gates: branch 1.2 — View projection engine (integration)

OWNS: (verification-only)

Scope: mapping store, SQL emitter, and lifecycle compose into real SQLite
views over episodes.

- [x] N1.2.1: engine suite passes end to end against a temp book.db
  CHECK: pnpm vitest run test/enrichment/views/ && echo views-branch-green
  EXPECT: views-branch-green
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/divyansh/Stratiki; path=a581e1b26f25/22 entries; output=(node:53419) ExperimentalWarning: SQLite is an experimental feature and might change at any time | (Use `node --trace-warnings ...` to show where the warning was created)

- [x] N1.2.2: children ledgers reverified clean
  CHECK: node ~/.claude/skills/unlazy/scripts/gate-check.mjs --status .unlazy/enrichment-p1/gates/leaf-1.2.1.md .unlazy/enrichment-p1/gates/leaf-1.2.2.md .unlazy/enrichment-p1/gates/leaf-1.2.2.1.md .unlazy/enrichment-p1/gates/leaf-1.2.3.md && echo engine-children-current
  EXPECT: engine-children-current
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/divyansh/Stratiki; path=a581e1b26f25/22 entries; output=ALL MET (4 met) | engine-children-current
