# Gates: leaf 1.1.3 — Text casefold/NFC normalizer

OWNS: src/enrichment/normalize/text.ts, test/enrichment/normalize/text.test.ts

Scope: `normalizeText(raw)`: NFC fold, whitespace collapse, casefold via
toLowerCase for matching keys; preserves original casing in a second field so
NER-sensitive consumers keep signals.

- [x] G1: text suite passes (accent folding, smart quotes, double spaces, CJK passthrough)
  CHECK: pnpm vitest run test/enrichment/normalize/text.test.ts && echo text-green
  EXPECT: text-green
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/divyansh/Stratiki; path=a581e1b26f25/22 entries; output=Duration  98ms (transform 14ms, setup 0ms, import 21ms, tests 2ms, environment 0ms) | text-green
