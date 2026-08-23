# Gates: branch 1.1 — Normalizer library (integration)

OWNS: (verification-only)

Scope: all four normalizer leaves integrate through the registry API and no
existing suite regresses.

- [x] N1.1.1: registry resolves every FieldKind and the library suite passes
  CHECK: pnpm vitest run test/enrichment/normalize/ && echo normalize-branch-green
  EXPECT: normalize-branch-green
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/divyansh/Stratiki; path=a581e1b26f25/22 entries; output=Duration  130ms (transform 140ms, setup 0ms, import 188ms, tests 15ms, environment 0ms) | normalize-branch-green

- [x] N1.1.2: children ledgers reverified clean
  CHECK: node ~/.claude/skills/unlazy/scripts/gate-check.mjs --status .unlazy/enrichment-p1/gates/leaf-1.1.1.md .unlazy/enrichment-p1/gates/leaf-1.1.2.md .unlazy/enrichment-p1/gates/leaf-1.1.3.md .unlazy/enrichment-p1/gates/leaf-1.1.4.md && echo children-current
  EXPECT: children-current
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/divyansh/Stratiki; path=a581e1b26f25/22 entries; output=ALL MET (4 met) | children-current
