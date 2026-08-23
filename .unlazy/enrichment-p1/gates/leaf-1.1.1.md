# Gates: leaf 1.1.1 — Phone normalizer facade

OWNS: src/enrichment/normalize/phone.ts, test/enrichment/normalize/phone.facade.test.ts

Scope: expose `normalizePhone(raw): NormalizeResult` over the 1.1.1.1 core,
rejecting non-string input without throwing.

- [x] G1: facade delegates to core and passes its suite
  CHECK: pnpm vitest run test/enrichment/normalize/phone.facade.test.ts && echo phone-facade-green
  EXPECT: phone-facade-green
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/divyansh/Stratiki; path=a581e1b26f25/22 entries; output=Duration  93ms (transform 15ms, setup 0ms, import 22ms, tests 2ms, environment 0ms) | phone-facade-green
