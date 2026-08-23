import {
  createRunId,
  readConnectorConfig,
  readConnectorState,
  updateStateWithRun,
  writeConnectorState,
  writeRawJson,
} from "../io.js";
import { fetchWithResilience } from "../http.js";
import { openWikiConnectorsDisplayPath } from "../../config/openwiki-home.js";
import type {
  ConnectorDefinition,
  ConnectorIngestOptions,
  ConnectorIngestResult,
  ConnectorRuntime,
} from "../types.js";

type GoogleSheetsConfig = {
  enabled?: boolean;
  maxRowsPerRange?: number;
  spreadsheets?: GoogleSheetSource[];
};

type GoogleSheetSource = {
  range: string;
  spreadsheetId: string;
};

type SheetsValuesResponse = {
  majorDimension?: string;
  values?: string[][];
};

const SHEETS_API_BASE_URL = "https://sheets.googleapis.com";

const definition: ConnectorDefinition = {
  backend: "direct-api",
  description:
    "Fetches tabular rows from configured Google Sheets ranges through the Sheets API v4.",
  displayName: "Google Sheets",
  id: "google-sheets",
  mode: "personal",
  requiredEnv: ["GOOGLE_SHEETS_ACCESS_TOKEN"],
  supportsAgenticDiscovery: false,
};

export function createGoogleSheetsConnector(): ConnectorRuntime {
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
    ...(await readConnectorConfig<GoogleSheetsConfig>("google-sheets", {
      enabled: true,
      maxRowsPerRange: 500,
      spreadsheets: [],
    })),
    ...((options.connectorConfig ?? {}) as GoogleSheetsConfig),
  };
  const state = await readConnectorState("google-sheets");
  const warnings: string[] = [];
  const rawFiles: string[] = [];

  if (!config.enabled) {
    return finishGoogleSheetsRun({
      message: `Google Sheets connector is not enabled. Set enabled=true in ${openWikiConnectorsDisplayPath}/google-sheets/config.json.`,
      rawFiles,
      runId,
      state,
      status: "skipped",
      warnings,
    });
  }

  const accessToken = process.env.GOOGLE_SHEETS_ACCESS_TOKEN;
  if (typeof accessToken !== "string" || accessToken.trim().length === 0) {
    return finishGoogleSheetsRun({
      message:
        "GOOGLE_SHEETS_ACCESS_TOKEN is not set. Provide an OAuth token with the spreadsheets.readonly scope.",
      rawFiles,
      runId,
      state,
      status: "error",
      warnings,
    });
  }

  if (!Array.isArray(config.spreadsheets) || config.spreadsheets.length === 0) {
    return finishGoogleSheetsRun({
      message: `No sheets configured. Add {spreadsheetId, range} entries to ${openWikiConnectorsDisplayPath}/google-sheets/config.json.`,
      rawFiles,
      runId,
      state,
      status: "skipped",
      warnings,
    });
  }

  const maxRowsPerRange = normalizeMaxRows(
    options.limit ?? config.maxRowsPerRange,
  );

  const exports: SheetExport[] = [];
  // Every configured range is processed; there is no silent cap.
  for (const source of config.spreadsheets) {
    if (!isWellFormedSheetSource(source)) {
      warnings.push(`skipping malformed sheet entry ${JSON.stringify(source)}`);
      continue;
    }
    try {
      exports.push({
        range: source.range,
        rows: await readSheetValues(
          accessToken.trim(),
          source.spreadsheetId,
          boundRange(source.range, maxRowsPerRange),
          maxRowsPerRange,
        ),
        spreadsheetId: source.spreadsheetId,
      });
    } catch (error) {
      warnings.push(`${source.spreadsheetId}: ${getErrorMessage(error)}`);
    }
  }

  rawFiles.push(
    await writeRawJson("google-sheets", runId, "sheets-rows.json", {
      exports,
      fetchedAt: new Date().toISOString(),
      instanceId: options.instanceId,
    }),
  );

  const totalRows = exports.reduce(
    (total, sheet) => total + sheet.rows.length,
    0,
  );

  return finishGoogleSheetsRun({
    message: `Fetched ${totalRows} row${totalRows === 1 ? "" : "s"} across ${
      exports.length
    } sheet range${exports.length === 1 ? "" : "s"}.`,
    rawFiles,
    runId,
    state,
    status: exports.length > 0 ? "success" : "error",
    warnings,
  });
}

async function finishGoogleSheetsRun({
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
    "google-sheets",
    updateStateWithRun(state, {
      at: new Date().toISOString(),
      rawFiles,
      runId,
      status,
      warnings,
    }),
  );

  return {
    connectorId: "google-sheets",
    message,
    rawFiles,
    runId,
    statePath: `${openWikiConnectorsDisplayPath}/google-sheets/state.json`,
    status,
    warnings,
  };
}

/**
 * Reads one A1 range and returns up to `maxRows` rows. All cell values are
 * kept as strings exactly as the API reports them.
 */
async function readSheetValues(
  accessToken: string,
  spreadsheetId: string,
  range: string,
  maxRows: number,
): Promise<string[][]> {
  const url = new URL(
    `/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`,
    SHEETS_API_BASE_URL,
  );
  url.searchParams.set("majorDimension", "ROWS");
  url.searchParams.set("valueRenderOption", "UNFORMATTED_VALUE");

  const response = await fetchWithResilience(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(
      `Google Sheets request failed: ${response.status} ${response.statusText}`,
    );
  }

  const payload = (await response.json()) as SheetsValuesResponse;

  return (payload.values ?? [])
    .slice(0, maxRows)
    .map((row) => row.map((cell) => String(cell)));
}

function isWellFormedSheetSource(
  source: GoogleSheetSource,
): source is { range: string; spreadsheetId: string } {
  return (
    typeof source === "object" &&
    source !== null &&
    typeof source.spreadsheetId === "string" &&
    source.spreadsheetId.trim().length > 0 &&
    typeof source.range === "string" &&
    source.range.trim().length > 0
  );
}

/**
 * Bounds an unbounded A1 range to at most `maxRows` rows so oversized requests
 * fail fast server-side instead of streaming the whole sheet into memory.
 * Ranges with an explicit end row are user-bounded and passed through as-is.
 *
 * @param range - A1 notation range, optionally prefixed with a sheet name.
 * @param maxRows - Maximum rows the caller will keep.
 * @returns A1 range whose row count never exceeds `maxRows`.
 */
function boundRange(range: string, maxRows: number): string {
  const separator = range.lastIndexOf("!");
  const title = separator === -1 ? "" : range.slice(0, separator + 1);
  const cells = range.slice(separator + 1);

  const match = /^([A-Z]+)(\d*):([A-Z]+)(\d*)$/u.exec(cells.toUpperCase());
  if (match === null) return range;

  const [, startColumn, startRow, endColumn, endRow] = match;
  if (startRow === undefined || endColumn === undefined) return range;

  // Explicit end row: the user bounded their own range.
  if (endRow !== undefined && endRow.length > 0 && startRow.length > 0) {
    return range;
  }

  const firstRow = startRow.length > 0 ? Number.parseInt(startRow, 10) : 1;
  if (!Number.isSafeInteger(firstRow)) return range;

  return `${title}${startColumn}${firstRow}:${endColumn}${firstRow + maxRows - 1}`;
}

type SheetExport = {
  range: string;
  rows: string[][];
  spreadsheetId: string;
};

function normalizeMaxRows(maxRows: number | undefined): number {
  const limit =
    typeof maxRows === "number" && Number.isFinite(maxRows) ? maxRows : 500;

  return Math.max(1, Math.min(10000, Math.trunc(limit)));
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
