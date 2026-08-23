import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  createRunId,
  readConnectorConfig,
  readConnectorState,
  updateStateWithRun,
  writeConnectorState,
  writeRawJson,
} from "../io.js";
import { openWikiConnectorsDisplayPath } from "../../config/openwiki-home.js";
import type {
  ConnectorDefinition,
  ConnectorIngestOptions,
  ConnectorIngestResult,
  ConnectorRuntime,
} from "../types.js";

type SqliteConfig = {
  enabled?: boolean;
  maxRowsPerTable?: number;
  path?: string;
  tables?: string[];
};

type TableColumn = {
  name: string;
  type: string;
};

type TableSnapshot = {
  columns: TableColumn[];
  name: string;
  rowCount: number;
  rows: Record<string, string | number | bigint | null>[];
};

const definition: ConnectorDefinition = {
  backend: "local-store",
  description:
    "Reads schema, row counts, and bounded row samples from configured tables of a local SQLite database opened read-only.",
  displayName: "SQLite Database",
  id: "sqlite",
  mode: "personal",
  requiredEnv: [],
  supportsAgenticDiscovery: false,
};

export function createSqliteConnector(): ConnectorRuntime {
  return {
    ...definition,
    ingest,
  };
}

async function ingest(
  options: ConnectorIngestOptions = {},
): Promise<ConnectorIngestResult> {
  const runId = createRunId();
  const config = {
    ...(await readConnectorConfig<SqliteConfig>("sqlite", {
      enabled: true,
      maxRowsPerTable: 100,
      path: "",
      tables: [],
    })),
    ...((options.connectorConfig ?? {}) as SqliteConfig),
  };
  const state = await readConnectorState("sqlite");
  const warnings: string[] = [];
  const rawFiles: string[] = [];

  if (!config.enabled) {
    return finishSqliteRun({
      message: `SQLite connector is not enabled. Set enabled=true in ${openWikiConnectorsDisplayPath}/sqlite/config.json.`,
      rawFiles,
      runId,
      state,
      status: "skipped",
      warnings,
    });
  }

  const rawPath = config.path;
  const databasePath = typeof rawPath === "string" ? rawPath.trim() : "";
  if (databasePath.length === 0 || !existsSync(databasePath)) {
    return finishSqliteRun({
      message: `No SQLite database found. Set path to an existing .sqlite/.db file in ${openWikiConnectorsDisplayPath}/sqlite/config.json.`,
      rawFiles,
      runId,
      state,
      status: "error",
      warnings,
    });
  }

  const maxRowsPerTable = normalizeMaxRows(
    options.limit ?? config.maxRowsPerTable,
  );
  const home = process.env.HOME ?? process.env.USERPROFILE;

  try {
    // Read-only open: the connector never creates or mutates user databases.
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const tableNames =
        config.tables && config.tables.length > 0
          ? config.tables.filter(
              (table): table is string => typeof table === "string",
            )
          : listUserTables(database);

      const snapshots: TableSnapshot[] = [];
      for (const tableName of tableNames) {
        try {
          snapshots.push(snapshotTable(database, tableName, maxRowsPerTable));
        } catch (error) {
          warnings.push(`${tableName}: ${getErrorMessage(error)}`);
        }
      }

      rawFiles.push(
        await writeRawJson("sqlite", runId, "sqlite-snapshot.json", {
          databasePath: toDisplayPath(home, databasePath),
          fetchedAt: new Date().toISOString(),
          instanceId: options.instanceId,
          tables: snapshots,
        }),
      );

      return finishSqliteRun({
        message: `Snapshotted ${snapshots.length} table${
          snapshots.length === 1 ? "" : "s"
        } from ${path.basename(databasePath)}.`,
        rawFiles,
        runId,
        state,
        status: snapshots.length > 0 ? "success" : "error",
        warnings,
      });
    } finally {
      database.close();
    }
  } catch (error) {
    warnings.push(`database: ${getErrorMessage(error)}`);
    return finishSqliteRun({
      message: `SQLite ingestion failed: ${getErrorMessage(error)}`,
      rawFiles,
      runId,
      state,
      status: "error",
      warnings,
    });
  }
}

async function finishSqliteRun({
  message,
  rawFiles,
  runId,
  state,
  status,
  warnings,
}: {
  message: string;
  rawFiles: string[];
  runId: string;
  state: Awaited<ReturnType<typeof readConnectorState>>;
  status: ConnectorIngestResult["status"];
  warnings: string[];
}): Promise<ConnectorIngestResult> {
  await writeConnectorState(
    "sqlite",
    updateStateWithRun(state, {
      at: new Date().toISOString(),
      rawFiles,
      runId,
      status,
      warnings,
    }),
  );

  return {
    connectorId: "sqlite",
    message,
    rawFiles,
    runId,
    statePath: `${openWikiConnectorsDisplayPath}/sqlite/state.json`,
    status,
    warnings,
  };
}

/**
 * Lists ordinary user tables via `pragma_table_list`, excluding SQLite
 * internals, virtual tables, and FTS shadow tables.
 */
function listUserTables(database: DatabaseSync): string[] {
  const rows = database
    .prepare(
      "SELECT name FROM pragma_table_list WHERE schema = 'main' AND type = 'table' AND name NOT LIKE 'sqlite_%'",
    )
    .all() as { name: unknown }[];

  return rows.flatMap((row) =>
    typeof row.name === "string" ? [row.name] : [],
  );
}

/**
 * Captures column metadata, a total row count, and one bounded ordered sample.
 */
function snapshotTable(
  database: DatabaseSync,
  tableName: string,
  maxRows: number,
): TableSnapshot {
  const quoted = escapeIdentifier(tableName);

  const pragmaRows = database.prepare(`PRAGMA table_info(${quoted})`).all() as {
    name: unknown;
    type: unknown;
  }[];
  const columns: TableColumn[] = pragmaRows.flatMap((row) =>
    typeof row.name === "string"
      ? [{ name: row.name, type: typeof row.type === "string" ? row.type : "" }]
      : [],
  );

  const countRow = database
    .prepare(`SELECT COUNT(*) AS count FROM ${quoted}`)
    .get() as { count: unknown };
  const rowCount = typeof countRow.count === "number" ? countRow.count : 0;

  const sampleStatement = database.prepare(`SELECT * FROM ${quoted} LIMIT ?`);
  // Large 64-bit integers are read as BigInt so they are never lossy.
  sampleStatement.setReadBigInts(true);
  const sampleRows = sampleStatement.all(maxRows) as Record<
    string,
    string | number | bigint | null
  >[];

  return {
    columns,
    name: tableName,
    rowCount,
    rows: sampleRows.map(jsonSafeRow),
  };
}

/**
 * Converts BigInt cell values to explicit decimal strings so the raw snapshot
 * stays valid JSON without precision loss.
 */
function jsonSafeRow(row: Record<string, string | number | bigint | null>): {
  [column: string]: string | number | null;
} {
  return Object.fromEntries(
    Object.entries(row).map(([column, value]) => [
      column,
      typeof value === "bigint" ? value.toString() : value,
    ]),
  );
}

/**
 * Quotes a table name as a SQL identifier. Double quotes inside the name are
 * doubled per SQLite escaping rules; only truly unusable names are rejected.
 */
function escapeIdentifier(tableName: string): string {
  if (tableName.length === 0 || tableName.includes("\0")) {
    throw new Error(`Refusing unsafe table identifier: ${tableName}`);
  }

  return `"${tableName.replaceAll('"', '""')}"`;
}

/**
 * Renders paths relative to the user's home when the database lives under it
 * so raw dumps never contain absolute home paths.
 */
function toDisplayPath(home: string | undefined, filePath: string): string {
  if (home === undefined || home.length === 0) {
    return path.basename(filePath);
  }
  const relative = path.relative(home, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return filePath;
  }

  return relative.split(path.sep).join("/");
}

function normalizeMaxRows(maxRows: number | undefined): number {
  const limit =
    typeof maxRows === "number" && Number.isFinite(maxRows) ? maxRows : 100;

  return Math.max(1, Math.min(1000, Math.trunc(limit)));
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
