# Gates: leaf 1.1.1.1.1 — Phone portability test matrix

OWNS: test/enrichment/normalize/phone-matrix.test.ts

Scope: table-driven matrix over locale-formatted fixtures (spaces, dashes,
parens, dots, leading zeros, extensions "x123", unicode digits) asserting
one normalized output each; guards the core against regex/unicode drift.

- [x] G1: full matrix passes with zero skipped cases
  CHECK: pnpm vitest run test/enrichment/normalize/phone-matrix.test.ts && echo phone-matrix-green
  EXPECT: phone-matrix-green
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/divyansh/Stratiki; path=a581e1b26f25/22 entries; output=Duration  106ms (transform 17ms, setup 0ms, import 24ms, tests 3ms, environment 0ms) | phone-matrix-green
