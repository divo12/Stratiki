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

  const databasePath = config.path?.trim() ?? "";
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

  try {
    // Read-only open: the connector never creates or mutates user databases.
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const tableNames =
        config.tables && config.tables.length > 0
          ? config.tables
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
          databasePath: path.resolve(databasePath),
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
 * Lists ordinary user tables (excluding SQLite internals and shadow tables).
 */
function listUserTables(database: DatabaseSync): string[] {
  const rows = database
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
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
  assertSafeIdentifier(tableName);

  const pragmaRows = database
    .prepare(`PRAGMA table_info("${tableName}")`)
    .all() as {
    name: unknown;
    type: unknown;
  }[];
  const columns: TableColumn[] = pragmaRows.flatMap((row) =>
    typeof row.name === "string"
      ? [{ name: row.name, type: typeof row.type === "string" ? row.type : "" }]
      : [],
  );

  const countRow = database
    .prepare(`SELECT COUNT(*) AS count FROM "${tableName}"`)
    .get() as { count: unknown };
  const rowCount = typeof countRow.count === "number" ? countRow.count : 0;

  const sampleRows = database
    .prepare(`SELECT * FROM "${tableName}" LIMIT ?`)
    .all(maxRows) as Record<string, string | number | bigint | null>[];

  return {
    columns,
    name: tableName,
    rowCount,
    rows: sampleRows,
  };
}

// Table names come from config or the schema; quote-escape is not enough on its
// own, so reject anything that could break out of the quoted identifier.
function assertSafeIdentifier(tableName: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/u.test(tableName)) {
    throw new Error(`Refusing unsafe table identifier: ${tableName}`);
  }
}

function normalizeMaxRows(maxRows: number | undefined): number {
  const limit =
    typeof maxRows === "number" && Number.isFinite(maxRows) ? maxRows : 100;

  return Math.max(1, Math.min(1000, Math.trunc(limit)));
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
