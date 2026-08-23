# Gates: leaf 1.3.1 — CRM dataset mappings

OWNS: src/enrichment/mappings/crm.ts, test/enrichment/mappings/crm.test.ts

Scope: typed mapping constants for stripe/stripe-events, zendesk/zendesk-tickets,
salesforce/salesforce-records, hubspot/hubspot-records — projected columns use
phone-e164/text-casefold kinds where fields qualify.

- [x] G1: CRM mapping suite passes (shape + emitted-view round-trip on fixture episodes)
  CHECK: pnpm vitest run test/enrichment/mappings/crm.test.ts && echo crm-mappings-green
  EXPECT: crm-mappings-green
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/divyansh/Stratiki; path=a581e1b26f25/22 entries; output=(node:54199) ExperimentalWarning: SQLite is an experimental feature and might change at any time | (Use `node --trace-warnings ...` to show where the warning was created)
