# Gates: leaf 1.1.2 — Address structurer

OWNS: src/enrichment/normalize/address.ts, test/enrichment/normalize/address.test.ts

Scope: pure `normalizeAddress(raw): NormalizeResult` producing canonical JSON
{line1, city, region, postal, country}; unknown parts empty strings; never
throws; comma-and-space parsing only (no external geocoder).

- [x] G1: address suite passes (US two/three-part, postal+country, garbage-in → ok:false)
  CHECK: pnpm vitest run test/enrichment/normalize/address.test.ts && echo address-green
  EXPECT: address-green
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/divyansh/Stratiki; path=a581e1b26f25/22 entries; output=Duration  93ms (transform 15ms, setup 0ms, import 21ms, tests 3ms, environment 0ms) | address-green
