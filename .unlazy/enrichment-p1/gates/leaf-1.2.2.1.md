# Gates: leaf 1.2.2.1 — Identifier-injection safety matrix

OWNS: test/enrichment/views/emitter.safety.test.ts

Scope: adversarial fixtures (quotes, semicolons, dashes, unicode, DROP TABLE
payloads) as dataset/column/path values prove the validator rejects every one
via ViewMappingError before any string reaches SQL; positive control shows the
same validator accepting a known-good mapping.

- [x] G1: safety matrix passes including positive control
  CHECK: pnpm vitest run test/enrichment/views/emitter.safety.test.ts && echo injection-matrix-green
  EXPECT: injection-matrix-green
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/divyansh/Stratiki; path=a581e1b26f25/22 entries; output=Duration  107ms (transform 17ms, setup 0ms, import 24ms, tests 6ms, environment 0ms) | injection-matrix-green
