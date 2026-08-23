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
