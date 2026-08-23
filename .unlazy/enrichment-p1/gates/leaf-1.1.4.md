# Gates: leaf 1.1.4 — Registry API

OWNS: src/enrichment/normalize/index.ts, test/enrichment/normalize/index.test.ts

Scope: static registry mapping every FieldKind to its implementation;
`normalizeValue` dispatches exhaustively (no dynamic lookup); unknown kind is
a compile-time error.

- [x] G1: registry suite passes (exhaustive dispatch, result-shape contract)
  CHECK: pnpm vitest run test/enrichment/normalize/index.test.ts && echo registry-green
  EXPECT: registry-green
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/divyansh/Stratiki; path=a581e1b26f25/22 entries; output=Duration  104ms (transform 21ms, setup 0ms, import 29ms, tests 2ms, environment 0ms) | registry-green
