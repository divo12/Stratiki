import type { FieldKind } from "../normalize/index.js";
import type { ViewMappingSet } from "../../book/view-mappings.js";

export class ViewMappingError extends Error {}

const IDENTIFIER_PATTERN = /^[a-z0-9_]+$/u;
const CONNECTOR_ID_PATTERN = /^[a-z][a-z0-9-]*$/u;
const FORBIDDEN_IDENTIFIERS = new Set(["constructor", "prototype", "__proto__"]);
const JSON_PATH_PATTERN = /^[A-Za-z0-9_.[\]-]+$/u;

/**
 * Derives the SQL view name for one dataset id.
 *
 * @param datasetId - Catalog-style id, `<connector-id>/<artifact-stem>`.
 * @returns Sanitized view name prefixed with `v_`.
 */
export function viewNameForDataset(datasetId: string): string {
  const sanitized = `${datasetId}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "");

  if (!IDENTIFIER_PATTERN.test(sanitized)) {
    throw new ViewMappingError(`Dataset id sanitizes to an invalid identifier: ${datasetId}`);
  }

  return `v_${sanitized}`;
}

/**
 * Emits the `CREATE VIEW` statement for one mapping set.
 *
 * Columns project via `json_extract` on the episode content, wrapped in the
 * registered `enrich_normalize` UDF when a normalizer kind is declared. All
 * identifiers are validated before interpolation; JSON path literals escape
 * single quotes by doubling.
 *
 * @param set - Complete mapping set from the mapping store.
 * @returns Deterministic CREATE VIEW SQL.
 */
export function emitCreateView(set: ViewMappingSet): string {
  const viewName = viewNameForDataset(set.datasetId);
  const connectorId = set.datasetId.split("/")[0] ?? "";
  if (!CONNECTOR_ID_PATTERN.test(connectorId)) {
    throw new ViewMappingError(
      `Dataset id must start with a valid connector id: ${set.datasetId}`,
    );
  }
  if (set.columns.length === 0) {
    throw new ViewMappingError(
      `Dataset has no projected columns: ${set.datasetId}`,
    );
  }

  const projections = set.columns.map((column) => {
    assertValidColumnName(column.columnName);
    assertValidJsonPath(column.jsonPath);

    const extraction = `json_extract(content, '$.${escapePathLiteral(column.jsonPath)}')`;
    const projected =
      column.normalizer === ""
        ? extraction
        : `enrich_normalize('${assertNormalizerKind(column.normalizer)}', ${extraction})`;

    return `${projected} AS ${column.columnName}`;
  });

  return [
    `CREATE VIEW IF NOT EXISTS ${viewName} AS`,
    `SELECT ${projections.join(", ")}`,
    `FROM episodes WHERE connector_id = '${connectorId.replaceAll("'", "''")}'`,
  ].join(" ");
}

function assertValidColumnName(columnName: string): void {
  if (FORBIDDEN_IDENTIFIERS.has(columnName)) {
    throw new ViewMappingError(`Reserved view column name: ${columnName}`);
  }
  if (!IDENTIFIER_PATTERN.test(columnName)) {
    throw new ViewMappingError(`Invalid view column name: ${columnName}`);
  }
}

function assertValidJsonPath(jsonPath: string): void {
  if (jsonPath.length === 0 || !JSON_PATH_PATTERN.test(jsonPath)) {
    throw new ViewMappingError(`Invalid JSON path: ${jsonPath}`);
  }
}

function assertNormalizerKind(kind: string): FieldKind {
  if (
    kind !== "address" &&
    kind !== "phone-e164" &&
    kind !== "text-casefold"
  ) {
    throw new ViewMappingError(`Invalid normalizer kind: ${kind}`);
  }

  return kind;
}

function escapePathLiteral(jsonPath: string): string {
  return jsonPath.replaceAll("'", "''");
}
