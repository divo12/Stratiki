# Plan: Enrichment Phase 1 — virtual views + normalization registry

Scope: enrichment-p1 (this file at .unlazy/enrichment-p1/PLAN.md)
Depth: tree 5
Mode: orchestrated

## Contract

- Interfaces:
  - Normalizer registry: `src/enrichment/normalize/index.ts` exports `normalizeValue(kind: FieldKind, raw: string): NormalizeResult` where `NormalizeResult = { ok: true; value: string } | { ok: false; reason: string }`; `FieldKind = "phone-e164" | "address" | "text-casefold"`.
  - Phone output: E.164 `+<countrycode><digits>` when a `+` lead exists, else digits-only; never throws.
  - Address output: canonical JSON `{ line1, city, region, postal, country }`, empty strings for unknown parts.
  - Mapping schema: `view_mappings` table `(dataset_id, view_name, column_name, json_path, normalizer, version)`; one row per projected column.
  - View naming: `v_` prefix + sanitized dataset stem (`stripe/stripe-events` → `v_stripe_stripe_events`).
  - SQL emitter input is mapping rows only; identifiers are validated against `/^[a-z0-9_]+$/u` before interpolation — anything else is a thrown `ViewMappingError`, never escaped-and-hopeful.
- Ownership: one complete disjoint set per leaf, listed in each ledger's `OWNS:` header.
- Dependencies: recorded per leaf below; rolling dispatch, sequential gate execution.
- Toolchain: Node ≥22, pnpm; all CHECK commands run from repository root via `pnpm`.
- Conventions: no comments unless required by house JSDoc style; fail-closed errors as typed error classes; tests colocated under `test/enrichment/`.
- Manual review: root ledger manual gate reviewed by the user (docs readability).

## Depth note (method honesty rule)

Depth 5 is honored on the two chains where a fifth layer is a real deliverable
(1.1.1.1.1 phone portability matrix; 1.2.2.1 identifier-injection fixtures are
depth-4 because their fifth level would be filler). Branches that end at depth
3 or 4 do so at genuine deliverable boundaries.

## State vocabulary

Leaf: WAITING | READY | IN-FLIGHT | VERIFIED | ABANDONED.
Branch: OPEN | VERIFIED | ABANDONED. (Definitions per unlazy method.md.)

## Tree

- 1 Enrichment Phase 1 ............................ GATES.md ............. State: VERIFIED
  - 1.1 Normalizer library ........................ gates/node-1.1.md ... State: VERIFIED
    - 1.1.1 Phone normalizer ...................... gates/leaf-1.1.1.md .. Needs: -
      └─ 1.1.1.1 E.164/digits core ................ gates/leaf-1.1.1.1.md  VERIFIED
         └─ 1.1.1.1.1 Portability test matrix ..... gates/leaf-1.1.1.1.1 Needs: - .... State: VERIFIED
    - 1.1.2 Address structurer .................... gates/leaf-1.1.2.md .. Needs: - .... READY
    - 1.1.3 Text casefold/NFC normalizer .......... gates/leaf-1.1.3.md .. Needs: - .... READY
    - 1.1.4 Registry API .......................... gates/leaf-1.1.4.md .. Needs: -
  - 1.2 View projection engine .................... gates/node-1.2.md ... State: VERIFIED
    - 1.2.1 Mapping schema + store methods ........ gates/leaf-1.2.1.md .. Needs: - .... READY
    - 1.2.2 SQL emitter ........................... gates/leaf-1.2.2.md .. 
      └─ 1.2.2.1 Identifier-injection safety matrix  gates/leaf-1.2.2.1.md 
    - 1.2.3 View lifecycle (create/replace/drop) .. gates/leaf-1.2.3.md .. 
  - 1.3 Dataset mappings .......................... gates/node-1.3.md ... State: VERIFIED
    - 1.3.1 CRM mappings (stripe/zendesk/salesforce/hubspot) gates/leaf-1.3.1.md 
    - 1.3.2 Aggregate mappings (google-ads/meta-ads/google-analytics) gates/leaf-1.3.2.md 
    - 1.3.3 Cross-dataset v_customers draft ....... gates/leaf-1.3.3.md .. 
  - 1.4 Integration & docs ........................ gates/node-1.4.md ... State: VERIFIED
    - 1.4.1 End-to-end ingest→admit→query fixture . gates/leaf-1.4.1.md .. 
    - 1.4.2 Docs + root reverify .................. gates/leaf-1.4.2.md .. 

## Status log

Append to `.unlazy/enrichment-p1/status.log` via
`node ~/.claude/skills/unlazy/scripts/gate-check.mjs --scope enrichment-p1 --log "<event>"`;
keep live State fields above updated in place.
