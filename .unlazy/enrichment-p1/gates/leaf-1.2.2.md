# Gates: leaf 1.2.2 — SQL emitter

OWNS: src/enrichment/views/emitter.ts, test/enrichment/views/emitter.test.ts

Scope: pure `emitCreateView(mapping): string` producing
`CREATE VIEW IF NOT EXISTS <v_name> AS SELECT json_extract(content,'$.path') AS col…FROM episodes WHERE connector_id…`
with dataset stem → v_ name sanitization and normalizer wrapping via registry kind.

- [x] G1: emitter suite passes (multi-column, normalizer wrap, name sanitize, stable output)
  CHECK: pnpm vitest run test/enrichment/views/emitter.test.ts && echo emitter-green
  EXPECT: emitter-green
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/divyansh/Stratiki; path=a581e1b26f25/22 entries; output=Duration  102ms (transform 15ms, setup 0ms, import 22ms, tests 2ms, environment 0ms) | emitter-green
