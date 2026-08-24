import type { DatabaseSync } from "node:sqlite";
import { emitCreateView, viewNameForDataset } from "./emitter.js";
import type { ViewMappingStore } from "../../book/view-mappings.js";
import { normalizeValue, type FieldKind } from "../normalize/index.js";

export type ViewSyncAction = "created" | "dropped" | "replaced" | "unchanged";

export interface ViewSyncOutcome {
  readonly action: ViewSyncAction;
  readonly viewName: string;
}

const udfRegisteredDbs = new WeakSet<DatabaseSync>();

/**
 * Collapses a CREATE VIEW statement into comparable form: SQLite strips
 * `IF NOT EXISTS` from stored DDL, so both sides drop it before comparing.
 *
 * @param sql - Any CREATE VIEW statement or stored sqlite_master.sql text.
 * @returns Whitespace-collapsed statement without the IF NOT EXISTS clause.
 */
function canonicalViewSql(sql: string): string {
  return sql
    .replace(/^CREATE VIEW (IF NOT EXISTS )?/iu, "CREATE VIEW ")
    .replace(/\s+/gu, " ")
    .trim();
}

/**
 * Registers the `enrich_normalize(kind, value)` UDF on one connection exactly
 * once. It delegates to the normalizer registry so emitted views apply the
 * same typed transformations tests exercise directly.
 *
 * @param db - Lake database connection used for view queries.
 */
function ensureNormalizeUdf(db: DatabaseSync): void {
  if (udfRegisteredDbs.has(db)) return;

  const normalizeHandler = (kind: unknown, value: unknown): string | null => {
    if (typeof kind !== "string" || typeof value !== "string") return null;
    const result = normalizeValue(kind as FieldKind, value);

    return result.ok ? result.value : null;
  };

  // Exact two-parameter arity: node:sqlite derives the SQL argument count
  // from function.length, so a rest-parameter registration would break.
  db.function("enrich_normalize", normalizeHandler);
  udfRegisteredDbs.add(db);
}

/**
 * Creates or refreshes the view for one dataset.
 *
 * The view is replaced when its stored DDL drifts from the freshly emitted
 * statement (mapping edit or version bump) and left untouched otherwise, so
 * repeated syncs are no-ops.
 *
 * @param db - Lake database connection.
 * @param mappings - Mapping store sharing the same database file.
 * @param datasetId - Dataset id to synchronize.
 * @returns What happened to the view.
 */
export function syncDatasetView(
  db: DatabaseSync,
  mappings: ViewMappingStore,
  datasetId: string,
): ViewSyncOutcome {
  ensureNormalizeUdf(db);

  const set = mappings.getMappings(datasetId);
  if (set === null) {
    throw new Error(`No mappings stored for dataset: ${datasetId}`);
  }

  const viewName = viewNameForDataset(datasetId);
  const sql = emitCreateView(set);
  const existingRow = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'view' AND name = ?")
    .get(viewName) as unknown as { sql: string | null } | undefined;

  if (existingRow === undefined) {
    db.exec(sql);

    return { action: "created", viewName };
  }

  const normalizedExisting = canonicalViewSql(existingRow.sql ?? "");
  const normalizedNew = canonicalViewSql(sql);
  if (normalizedExisting === normalizedNew) {
    return { action: "unchanged", viewName };
  }

  db.prepare(`DROP VIEW ${viewName}`).run();
  db.exec(sql);

  return { action: "replaced", viewName };
}

/**
 * Synchronizes every mapped dataset and drops views whose dataset lost its
 * mappings.
 *
 * @param db - Lake database connection.
 * @param mappings - Mapping store sharing the same database file.
 * @returns One outcome per touched view.
 */
export function syncAllViews(
  db: DatabaseSync,
  mappings: ViewMappingStore,
): ViewSyncOutcome[] {
  ensureNormalizeUdf(db);

  const outcomes: ViewSyncOutcome[] = [];
  for (const datasetId of mappings.listDatasets()) {
    outcomes.push(syncDatasetView(db, mappings, datasetId));
  }

  const keepNames = new Set(mappings.listDatasets().map(viewNameForDataset));
  const currentViews = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'view' AND name LIKE 'v\\_%' ESCAPE '\\'",
    )
    .all() as unknown as { name: string }[];

  for (const { name } of currentViews) {
    if (!keepNames.has(name)) {
      db.prepare(`DROP VIEW "${name}"`).run();
      outcomes.push({ action: "dropped", viewName: name });
    }
  }

  return outcomes;
}
