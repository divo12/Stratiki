import { DatabaseSync } from "node:sqlite";
import { mkdir } from "node:fs/promises";
import path from "node:path";

/**
 * Kind of normalization applied to a projected column, matching
 * {@link !import("../../enrichment/normalize/index.js").FieldKind}.
 * Empty string projects the raw JSON value untouched.
 */
export type ViewNormalizerKind = "" | "address" | "phone-e164" | "text-casefold";

/**
 * One projected column of a dataset view.
 */
export interface ViewMappingRow {
  /** SQL column name in the emitted view (`^[a-z0-9_]+$`). */
  readonly columnName: string;

  /** JSON path into the episode content, without the `$.` prefix. */
  readonly jsonPath: string;

  /** Normalizer kind applied at query time; empty for raw projection. */
  readonly normalizer: ViewNormalizerKind;
}

/**
 * The complete mapping set for one dataset view.
 */
export interface ViewMappingSet {
  /** Catalog-style dataset id, `<connector-id>/<artifact-stem>`. */
  readonly datasetId: string;

  /** Bump to force view replacement on next sync. */
  readonly version: number;

  readonly columns: readonly ViewMappingRow[];
}

interface MappingDbRow {
  column_name: string;
  json_path: string;
  normalizer: string;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS view_mappings (
  dataset_id TEXT NOT NULL,
  column_name TEXT NOT NULL,
  json_path TEXT NOT NULL,
  normalizer TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL,
  PRIMARY KEY (dataset_id, column_name)
);
`;

/**
 * Persists view mapping sets in the lake database. Rows are the single input
 * to the SQL emitter; no other component may hand-write view DDL.
 */
export class ViewMappingStore {
  private constructor(private readonly db: DatabaseSync) {}

  /**
   * Opens (creating if needed) the mapping store over one lake database.
   *
   * @param dbPath - Absolute path to the shared lake database file.
   */
  static async open(dbPath: string): Promise<ViewMappingStore> {
    await mkdir(path.dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    db.exec(SCHEMA_SQL);

    return new ViewMappingStore(db);
  }

  close(): void {
    this.db.close();
  }

  /**
   * Replaces the full mapping set for one dataset atomically.
   *
   * @param set - Complete mapping set to persist.
   */
  setMappings(set: ViewMappingSet): void {
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare("DELETE FROM view_mappings WHERE dataset_id = ?")
        .run(set.datasetId);
      const insert = this.db.prepare(
        `INSERT INTO view_mappings (dataset_id, column_name, json_path, normalizer, version)
         VALUES (?, ?, ?, ?, ?)`,
      );
      for (const row of set.columns) {
        insert.run(
          set.datasetId,
          row.columnName,
          row.jsonPath,
          row.normalizer,
          set.version,
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Loads the mapping set for one dataset.
   *
   * @param datasetId - Dataset id used at write time.
   * @returns The stored set, or `null` when none exists.
   */
  getMappings(datasetId: string): ViewMappingSet | null {
    const versionRow = this.db
      .prepare("SELECT MAX(version) AS version FROM view_mappings WHERE dataset_id = ?")
      .get(datasetId) as { version: number | bigint | null };
    if (versionRow.version === null) return null;

    const rows = this.db
      .prepare(
        "SELECT column_name, json_path, normalizer FROM view_mappings WHERE dataset_id = ? ORDER BY rowid",
      )
      .all(datasetId) as unknown as MappingDbRow[];

    return {
      columns: rows.map((row) => ({
        columnName: row.column_name,
        jsonPath: row.json_path,
        normalizer: row.normalizer as ViewNormalizerKind,
      })),
      datasetId,
      version: Number(versionRow.version),
    };
  }

  /**
   * Removes all mappings for one dataset.
   *
   * @param datasetId - Dataset id whose mappings should disappear.
   */
  clearDataset(datasetId: string): void {
    this.db
      .prepare("DELETE FROM view_mappings WHERE dataset_id = ?")
      .run(datasetId);
  }

  /**
   * Lists every dataset id that currently has mappings.
   *
   * @returns Sorted dataset ids.
   */
  listDatasets(): string[] {
    const rows = this.db
      .prepare("SELECT DISTINCT dataset_id FROM view_mappings ORDER BY dataset_id")
      .all() as unknown as { dataset_id: string }[];

    return rows.map((row) => row.dataset_id);
  }
}
