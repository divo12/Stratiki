# Enrichment (Phase 1)

The enrichment tier sits between the episode store (silver) and the claim
ledger (gold). Phase 1 is fully deterministic: a normalizer library, a view
mapping registry, and SQLite views projected from episodes.

## Normalizer library

`src/enrichment/normalize/index.ts` exposes `normalizeValue(kind, raw)` with
an exhaustive `FieldKind` union:

| Kind            | Output                                                                                                      |
| --------------- | ----------------------------------------------------------------------------------------------------------- |
| `phone-e164`    | E.164 when the input leads with `+`, else digits-only; extensions dropped; 7–15 significant digits enforced |
| `address`       | Canonical `{line1, city, region, postal, country}` JSON string                                              |
| `text-casefold` | NFC-folded, whitespace-collapsed, lowercased match key                                                      |

Every normalizer returns `{ok: true, value} | {ok: false, reason}` and never
throws.

## View mappings

`src/book/view-mappings.ts` exposes `ViewMappingStore`, persisting one mapping
set per dataset in the `view_mappings` table. Each row declares a column name,
a JSON path into the episode content (without the `$.` prefix), and an
optional normalizer kind. Bump `version` when a dataset's projection changes
shape.

## Views

`src/enrichment/views/emitter.ts` exposes `emitCreateView(mappingSet)`, which
compiles a mapping set into `CREATE VIEW` SQL over `episodes`, wrapping
columns in the registered `enrich_normalize(kind, value)` UDF. Identifiers are
validated against `^[a-z0-9_]+$` (with prototype-polluting names denied)
before interpolation; JSON path literals escape single quotes by doubling.

`src/enrichment/views/lifecycle.ts` exposes `syncDatasetView(db, mappings,
datasetId)` and `syncAllViews(db, mappings)`: views are created when absent,
replaced only when emitted DDL drifts, untouched otherwise, and dropped when a
dataset loses its mappings. Only explicitly tracked views are eligible for
cleanup; unknown `v_` views, including pre-registry orphans, are preserved
because their ownership cannot be proven safely.

View names are derived as `v_` + the dataset id with non-alphanumeric runs
collapsed to `_` (`stripe/stripe-events` → `v_stripe_stripe_events`).

## Dataset mappings

`src/enrichment/mappings/` declares static mapping sets for the record-level
datasets (CRM in `crm.ts`, aggregates in `aggregates.ts`) plus the
cross-dataset `v_customers` draft, which unions normalized contact emails by
exact lowercase key — no fuzzy matching exists in Phase 1.
