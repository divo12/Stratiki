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

type GoogleAnalyticsConfig = {
  dimensions?: string[];
  enabled?: boolean;
  lookbackDays?: number;
  metrics?: string[];
};

type Ga4RunReportResponse = {
  rows?: {
    dimensionValues?: { value?: string }[];
    metricValues?: { value?: string }[];
  }[];
  rowCount?: number;
};

const GA4_API_BASE_URL = "https://analyticsdata.googleapis.com";

const DEFAULT_DIMENSIONS = ["date", "sessionDefaultChannelGroup"];
const DEFAULT_METRICS = ["activeUsers", "sessions", "screenPageViews"];

// The report is deliberately small: one row per day and channel so wiki pages
// can cite traffic trends without pulling user-level data.
const definition: ConnectorDefinition = {
  backend: "direct-api",
  description:
    "Fetches recent GA4 traffic (users, sessions, page views by day and channel) through the Data API runReport.",
  displayName: "Google Analytics",
  id: "google-analytics",
  mode: "personal",
  requiredEnv: ["GA4_PROPERTY_ID", "GOOGLE_ANALYTICS_ACCESS_TOKEN"],
  supportsAgenticDiscovery: false,
};

export function createGoogleAnalyticsConnector(): ConnectorRuntime {
  return {
    ...definition,
    // GA4 rows are daily aggregates; the dump's event time is the end of the
    // requested reporting window.
    artifactEventTime: (parsed) => {
      if (!isRecord(parsed) || !isRecord(parsed.dateRange)) return null;
      if (typeof parsed.dateRange.endDate !== "string") return null;

      return `${parsed.dateRange.endDate}T23:59:59Z`;
    },
    ingest,
  };
}

async function ingest(
  options: ConnectorIngestOptions = {},
): Promise<ConnectorIngestResult> {
  const runId = createRunId();
  const config = {
    ...(await readConnectorConfig<GoogleAnalyticsConfig>("google-analytics", {
      enabled: true,
      lookbackDays: 7,
      metrics: DEFAULT_METRICS,
      dimensions: DEFAULT_DIMENSIONS,
    })),
    ...((options.connectorConfig ?? {}) as GoogleAnalyticsConfig),
  };
  const state = await readConnectorState("google-analytics");
  const warnings: string[] = [];
  const rawFiles: string[] = [];

  if (!config.enabled) {
    return finishGoogleAnalyticsRun({
      message: `Google Analytics connector is not enabled. Set enabled=true in ${openWikiConnectorsDisplayPath}/google-analytics/config.json.`,
      rawFiles,
      runId,
      state,
      status: "skipped",
      warnings,
    });
  }

  const accessToken = process.env.GOOGLE_ANALYTICS_ACCESS_TOKEN;
  const propertyId = process.env.GA4_PROPERTY_ID;
  if (
    typeof accessToken !== "string" ||
    accessToken.trim().length === 0 ||
    typeof propertyId !== "string" ||
    propertyId.trim().length === 0
  ) {
    return finishGoogleAnalyticsRun({
      message:
        "GA4_PROPERTY_ID or GOOGLE_ANALYTICS_ACCESS_TOKEN is not set. Provide a property id numeric identifier and an OAuth token with the Analytics readonly scope.",
      rawFiles,
      runId,
      state,
      status: "error",
      warnings,
    });
  }

  const lookbackDays = normalizeLookbackDays(
    options.windowHours === undefined
      ? config.lookbackDays
      : options.windowHours / 24,
  );
  const dimensions = normalizeStringList(config.dimensions, DEFAULT_DIMENSIONS);
  const metrics = normalizeStringList(config.metrics, DEFAULT_METRICS);
  const dateRange = {
    endDate: todayIsoDate(),
    startDate: isoDaysAgo(lookbackDays),
  };

  try {
    const report = await runReport(accessToken.trim(), propertyId.trim(), {
      dateRange,
      dimensions,
      metrics,
    });

    rawFiles.push(
      await writeRawJson("google-analytics", runId, "ga4-report.json", {
        dateRange,
        fetchedAt: new Date().toISOString(),
        instanceId: options.instanceId,
        lookbackDays,
        propertyId: propertyId.trim(),
        rowCount: report.rows?.length ?? 0,
        rows: report.rows ?? [],
      }),
    );

    return finishGoogleAnalyticsRun({
      message: `Fetched ${report.rows?.length ?? 0} GA4 report row${
        (report.rows?.length ?? 0) === 1 ? "" : "s"
      } for property ${propertyId.trim()} over ${lookbackDays} day${
        lookbackDays === 1 ? "" : "s"
      }.`,
      rawFiles,
      runId,
      state,
      status: "success",
      warnings,
    });
  } catch (error) {
    warnings.push(`runReport: ${getErrorMessage(error)}`);
    return finishGoogleAnalyticsRun({
      message: `Google Analytics ingestion failed: ${getErrorMessage(error)}`,
      rawFiles,
      runId,
      state,
      status: "error",
      warnings,
    });
  }
}

async function finishGoogleAnalyticsRun({
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
    "google-analytics",
    updateStateWithRun(state, {
      at: new Date().toISOString(),
      rawFiles,
      runId,
      status,
      warnings,
    }),
  );

  return {
    connectorId: "google-analytics",
    message,
    rawFiles,
    runId,
    statePath: `${openWikiConnectorsDisplayPath}/google-analytics/state.json`,
    status,
    warnings,
  };
}

/**
 * Runs one `runReport` call with an explicit date range and ordered
 * dimension/metric lists. Row-level responses are passed through as-is.
 */
async function runReport(
  accessToken: string,
  propertyId: string,
  reportOptions: {
    dateRange: { endDate: string; startDate: string };
    dimensions: string[];
    metrics: string[];
  },
): Promise<Ga4RunReportResponse> {
  const url = new URL(
    `/v1beta/properties/${propertyId}:runReport`,
    GA4_API_BASE_URL,
  );
  const response = await fetchWithResilience(url, {
    body: JSON.stringify({
      dateRanges: [reportOptions.dateRange],
      dimensions: reportOptions.dimensions.map((name) => ({ name })),
      metrics: reportOptions.metrics.map((name) => ({ name })),
    }),
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    method: "POST",
  });

  if (!response.ok) {
    throw new Error(
      `Google Analytics request failed: ${response.status} ${response.statusText}`,
    );
  }

  return (await response.json()) as Ga4RunReportResponse;
}
function normalizeLookbackDays(days: number | undefined): number {
  const value = typeof days === "number" && Number.isFinite(days) ? days : 7;

  return Math.max(1, Math.min(90, Math.trunc(value)));
}

/**
 * Normalizes a configured name list, keeping only non-empty strings and
 * falling back to the defaults when nothing usable remains.
 */
function normalizeStringList(
  values: string[] | undefined,
  fallback: string[],
): string[] {
  const usable = (values ?? []).filter(
    (value) => typeof value === "string" && value.trim().length > 0,
  );

  return usable.length > 0 ? usable : [...fallback];
}

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Narrows an unknown parsed value to a non-array object.
 *
 * @param value - Parsed JSON value.
 * @returns Whether the value is a string-keyed record.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
