import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { admitOrReject, type AdmissionDecision } from "./admission.js";

/**
 * The episode store: an append-only, bi-temporal record of admitted source
 * artifacts. Every episode carries both event time (when the source data was
 * produced) and ingest time (when Stratiki recorded it), following
 * Zep/Graphiti's bi-temporal discipline. Content is deduplicated on
 * (connectorId, sourceRef, contentHash): re-pulling identical data is a
 * no-op, so refresh loops can run as often as they like without growing the
 * store.
 */

const SCHEMA_VERSION = 1;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS episodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  connector_id TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  event_time TEXT NOT NULL,
  ingest_time TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  content TEXT NOT NULL,
  run_id TEXT NOT NULL,
  UNIQUE (connector_id, source_ref, content_hash)
);
CREATE INDEX IF NOT EXISTS idx_episodes_connector ON episodes (connector_id, ingest_time);
CREATE TABLE IF NOT EXISTS datasets (
  dataset_id TEXT PRIMARY KEY,
  partition_root TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  sample_record TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export interface EpisodeAdmission {
  readonly bytes: number;
  readonly connectorId: string;
  readonly content: string;
  /** ISO timestamp of when the source data was produced (event time). */
  readonly eventTimeIso: string;
  readonly runId: string;
  /** Stable identity of the artifact within the connector, e.g. its raw path. */
  readonly sourceRef: string;
}

export type EpisodeStoreResult =
  | {
      readonly decision: Extract<AdmissionDecision, { outcome: "reject" }>;
      readonly outcome: "rejected";
    }
  | {
      readonly episode: EpisodeRecord;
      readonly outcome: "admitted" | "duplicate";
    };

export interface EpisodeRecord {
  readonly bytes: number;
  readonly connectorId: string;
  readonly contentHash: string;
  readonly eventTimeIso: string;
  readonly id: number;
  readonly ingestTimeIso: string;
  readonly runId: string;
  readonly sourceRef: string;
}

/**
 * One registered lake dataset: a connector's artifact stream with its schema
 * identity and partition root, so rebuild tooling and query surfaces can
 * discover data without reading connector source code.
 */
export interface DatasetCatalogEntry {
  readonly datasetId: string;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly partitionRoot: string;
  readonly sampleRecord: string;
  readonly schemaVersion: number;
}

/**
 * Observation input that upserts one dataset row on admission.
 */
export interface DatasetObservation {
  readonly datasetId: string;

  /** Home-relative raw root the dataset's partitions live under. */
  readonly partitionRoot: string;

  /** Latest sample of the record shape, truncated by the caller. */
  readonly sampleRecord: string;

  /** Schema version of the selector that produced the records. */
  readonly schemaVersion: number;

  /** ISO timestamp of this observation. */
  readonly observedAtIso: string;
}

interface DatasetRow {
  dataset_id: string;
  first_seen_at: string;
  last_seen_at: string;
  partition_root: string;
  sample_record: string;
  schema_version: number | bigint;
}

interface EpisodeRow {
  id: number | bigint;
  connector_id: string;
  source_ref: string;
  content_hash: string;
  event_time: string;
  ingest_time: string;
  run_id: string;
  bytes: number | bigint;
}

export class BookStoreError extends Error {}

/**
 * Adds columns introduced after the initial release to pre-existing episode
 * tables. `CREATE TABLE IF NOT EXISTS` cannot alter an existing table, so
 * stores created before a column existed need this explicit step.
 */
function migrateEpisodesTable(db: DatabaseSync): void {
  const columns = (
    db.prepare("PRAGMA table_info(episodes)").all() as unknown as {
      name: string;
    }[]
  ).map((column) => column.name);

  if (columns.length > 0 && !columns.includes("run_id")) {
    db.exec("ALTER TABLE episodes ADD COLUMN run_id TEXT NOT NULL DEFAULT ''");
  }
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function rowToRecord(row: EpisodeRow): EpisodeRecord {
  return {
    bytes: Number(row.bytes),
    connectorId: row.connector_id,
    contentHash: row.content_hash,
    eventTimeIso: row.event_time,
    id: Number(row.id),
    ingestTimeIso: row.ingest_time,
    runId: row.run_id,
    sourceRef: row.source_ref,
  };
}

export class EpisodeStore {
  private constructor(private readonly db: DatabaseSync) {}

  /** Opens (creating if needed) the store at `dbPath`, running migrations. */
  static async open(dbPath: string): Promise<EpisodeStore> {
    await mkdir(path.dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    db.exec(SCHEMA_SQL);
    migrateEpisodesTable(db);
    db.prepare(
      "INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO NOTHING",
    ).run(String(SCHEMA_VERSION));

    return new EpisodeStore(db);
  }

  close(): void {
    this.db.close();
  }

  count(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM episodes").get() as {
      n: number | bigint;
    };

    return Number(row.n);
  }

  /**
   * Upserts one dataset observation. The first observation freezes
   * `first_seen_at`; later observations refresh the sample, schema version,
   * and last-seen stamp.
   */
  observeDataset(observation: DatasetObservation): void {
    this.db
      .prepare(
        `INSERT INTO datasets (dataset_id, partition_root, schema_version, sample_record, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(dataset_id) DO UPDATE SET
           partition_root = excluded.partition_root,
           schema_version = excluded.schema_version,
           sample_record = excluded.sample_record,
           last_seen_at = excluded.last_seen_at`,
      )
      .run(
        observation.datasetId,
        observation.partitionRoot,
        observation.schemaVersion,
        observation.sampleRecord,
        observation.observedAtIso,
        observation.observedAtIso,
      );
  }

  /**
   * Lists every registered dataset in stable id order.
   */
  listDatasets(): DatasetCatalogEntry[] {
    const rows = this.db
      .prepare("SELECT * FROM datasets ORDER BY dataset_id")
      .all() as unknown as DatasetRow[];

    return rows.map((row) => ({
      datasetId: row.dataset_id,
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
      partitionRoot: row.partition_root,
      sampleRecord: row.sample_record,
      schemaVersion: Number(row.schema_version),
    }));
  }

  /**
   * Applies the admission policy and, on admit, inserts the episode. A
   * conflicting (connector, ref, hash) triple reports `"duplicate"` with the
   * stored record and writes nothing, making refresh loops idempotent by
   * construction.
   */
  admit(input: EpisodeAdmission): EpisodeStoreResult {
    const decision = admitOrReject({
      bytes: input.bytes,
      content: input.content,
    });
    if (decision.outcome === "reject") {
      return { decision, outcome: "rejected" };
    }

    const contentHash = hashContent(input.content);
    const ingestTimeIso = new Date().toISOString();
    const insert = this.db.prepare(`
INSERT INTO episodes (connector_id, source_ref, content_hash, event_time, ingest_time, bytes, content, run_id)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (connector_id, source_ref, content_hash) DO NOTHING
`);
    const result = insert.run(
      input.connectorId,
      input.sourceRef,
      contentHash,
      input.eventTimeIso,
      ingestTimeIso,
      input.bytes,
      input.content,
      input.runId,
    );
    const outcome = Number(result.changes) > 0 ? "admitted" : "duplicate";

    const row = this.db
      .prepare(
        `SELECT id, connector_id, source_ref, content_hash, event_time, ingest_time, run_id, bytes
FROM episodes WHERE connector_id = ? AND source_ref = ? AND content_hash = ?`,
      )
      .get(input.connectorId, input.sourceRef, contentHash) as
      EpisodeRow | undefined;
    if (row === undefined) {
      throw new BookStoreError(
        `Episode vanished after insert: ${input.connectorId}/${input.sourceRef}`,
      );
    }

    return { episode: rowToRecord(row), outcome };
  }

  listRecent(limit: number): EpisodeRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, connector_id, source_ref, content_hash, event_time, ingest_time, run_id, bytes
FROM episodes ORDER BY ingest_time DESC, id DESC LIMIT ?`,
      )
      .all(limit) as unknown as EpisodeRow[];

    return rows.map((row) => rowToRecord(row));
  }
}
