# Gates: leaf 1.1.1.1 — E.164/digits phone core

OWNS: src/enrichment/normalize/phone-core.ts, test/enrichment/normalize/phone-core.test.ts

Scope: pure `normalizePhoneCore(raw: string)` — strips formatting, maps
`+`-led input to E.164, falls back to digits-only; returns `{ok:false}` on
<7 or >15 significant digits; never throws.

- [x] G1: core unit suite passes (US/UK/IN formats, +lead vs bare, letters rejected)
  CHECK: pnpm vitest run test/enrichment/normalize/phone-core.test.ts && echo phone-core-green
  EXPECT: phone-core-green
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/divyansh/Stratiki; path=a581e1b26f25/22 entries; output=Duration  112ms (transform 17ms, setup 0ms, import 24ms, tests 3ms, environment 0ms) | phone-core-green
