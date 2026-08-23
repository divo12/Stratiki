import {
  createRunId,
  maxIsoString,
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

type GoogleAdsConfig = {
  enabled?: boolean;
  lookbackDays?: number;
};

type GoogleAdsSearchStreamResponse = {
  results?: {
    campaign?: {
      id?: string;
      name?: string;
      status?: string;
    };
    metrics?: {
      clicks?: string;
      conversions?: string;
      costMicros?: string;
      impressions?: string;
    };
    segments?: { date?: string };
  }[];
};

const GOOGLE_ADS_API_BASE_URL = "https://googleads.googleapis.com";
const GOOGLE_ADS_API_VERSION = "v18";

// Cost is reported in micros by the Google Ads API; divide for account-currency
// spend with one decimal of precision.
const MICROS_PER_UNIT = 1_000_000;

const definition: ConnectorDefinition = {
  backend: "direct-api",
  description:
    "Fetches recent Google Ads campaign performance (cost, clicks, impressions, conversions) through the search stream API.",
  displayName: "Google Ads",
  id: "google-ads",
  mode: "personal",
  requiredEnv: [
    "GOOGLE_ADS_ACCESS_TOKEN",
    "GOOGLE_ADS_CUSTOMER_ID",
    "GOOGLE_ADS_DEVELOPER_TOKEN",
  ],
  supportsAgenticDiscovery: false,
};

export function createGoogleAdsConnector(): ConnectorRuntime {
  return {
    ...definition,
    // Performance rows are daily aggregates; the dump's event time is the
    // latest day present in the results.
    artifactEventTime: (parsed) => {
      if (!isRecord(parsed) || !Array.isArray(parsed.rows)) return null;

      return maxIsoString(
        parsed.rows.flatMap((row) =>
          isRecord(row) && typeof row.date === "string"
            ? [`${row.date}T23:59:59Z`]
            : [],
        ),
      );
    },
    ingest,
  };
}

async function ingest(
  options: ConnectorIngestOptions = {},
): Promise<ConnectorIngestResult> {
  const runId = createRunId();
  const config = {
    ...(await readConnectorConfig<GoogleAdsConfig>("google-ads", {
      enabled: true,
      lookbackDays: 7,
    })),
    ...((options.connectorConfig ?? {}) as GoogleAdsConfig),
  };
  const state = await readConnectorState("google-ads");
  const warnings: string[] = [];
  const rawFiles: string[] = [];

  if (!config.enabled) {
    return finishGoogleAdsRun({
      message: `Google Ads connector is not enabled. Set enabled=true in ${openWikiConnectorsDisplayPath}/google-ads/config.json.`,
      rawFiles,
      runId,
      state,
      status: "skipped",
      warnings,
    });
  }

  const accessToken = process.env.GOOGLE_ADS_ACCESS_TOKEN;
  const customerId = process.env.GOOGLE_ADS_CUSTOMER_ID;
  const developerToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
  if (
    typeof accessToken !== "string" ||
    accessToken.trim().length === 0 ||
    typeof customerId !== "string" ||
    customerId.trim().length === 0 ||
    typeof developerToken !== "string" ||
    developerToken.trim().length === 0
  ) {
    return finishGoogleAdsRun({
      message:
        "GOOGLE_ADS_ACCESS_TOKEN, GOOGLE_ADS_CUSTOMER_ID, or GOOGLE_ADS_DEVELOPER_TOKEN is not set. Provide an OAuth token with the AdWords scope, a 10-digit customer id (digits only), and an approved developer token.",
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

  try {
    const rows = await searchCampaignPerformance(
      accessToken.trim(),
      customerId.trim(),
      developerToken.trim(),
      lookbackDays,
    );

    rawFiles.push(
      await writeRawJson("google-ads", runId, "google-ads-performance.json", {
        customerId: customerId.trim(),
        fetchedAt: new Date().toISOString(),
        instanceId: options.instanceId,
        lookbackDays,
        rowCount: rows.length,
        rows,
      }),
    );

    return finishGoogleAdsRun({
      message: `Fetched performance for ${rows.length} campaign${
        rows.length === 1 ? "" : "s"
      } over ${lookbackDays} day${lookbackDays === 1 ? "" : "s"}.`,
      rawFiles,
      runId,
      state,
      status: "success",
      warnings,
    });
  } catch (error) {
    warnings.push(`searchStream: ${getErrorMessage(error)}`);
    return finishGoogleAdsRun({
      message: `Google Ads ingestion failed: ${getErrorMessage(error)}`,
      rawFiles,
      runId,
      state,
      status: "error",
      warnings,
    });
  }
}

async function finishGoogleAdsRun({
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
    "google-ads",
    updateStateWithRun(state, {
      at: new Date().toISOString(),
      rawFiles,
      runId,
      status,
      warnings,
    }),
  );

  return {
    connectorId: "google-ads",
    message,
    rawFiles,
    runId,
    statePath: `${openWikiConnectorsDisplayPath}/google-ads/state.json`,
    status,
    warnings,
  };
}

/**
 * Runs one GAQL statement over the search stream endpoint and flattens the
 * per-day campaign rows into plain numbers.
 */
async function searchCampaignPerformance(
  accessToken: string,
  customerId: string,
  developerToken: string,
  lookbackDays: number,
): Promise<CampaignPerformanceRow[]> {
  const url = new URL(
    `/${GOOGLE_ADS_API_VERSION}/customers/${customerId}/googleAds:searchStream`,
    GOOGLE_ADS_API_BASE_URL,
  );
  const response = await fetchWithResilience(url, {
    body: JSON.stringify({
      query: `
        SELECT campaign.id, campaign.name, campaign.status,
               segments.date, metrics.clicks, metrics.conversions,
               metrics.cost_micros, metrics.impressions
        FROM campaign
        WHERE segments.date BETWEEN '${gaqlDate(lookbackDays)}' AND '${gaqlDate(0)}'
          AND campaign.status != 'REMOVED'`.trim(),
    }),
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "developer-token": developerToken,
    },
    method: "POST",
  });

  if (!response.ok) {
    throw new Error(
      `Google Ads request failed: ${response.status} ${response.statusText}`,
    );
  }

  // The search stream returns a JSON array of batch elements; flatten every
  // batch so multi-batch responses never drop campaign-day rows.
  const batches = (await response.json()) as GoogleAdsSearchStreamResponse[];

  return batches.flatMap((batch) =>
    (batch.results ?? []).flatMap((result) => {
      if (typeof result.campaign?.id !== "string") return [];
      return [
        {
          campaignId: result.campaign.id,
          campaignName: result.campaign.name,
          campaignStatus: result.campaign.status,
          clicks: toNumber(result.metrics?.clicks),
          conversions: toNumber(result.metrics?.conversions),
          cost: toCost(result.metrics?.costMicros),
          date: result.segments?.date,
          impressions: toNumber(result.metrics?.impressions),
        },
      ];
    }),
  );
}

type CampaignPerformanceRow = {
  campaignId: string;
  campaignName: string | undefined;
  campaignStatus: string | undefined;
  clicks: number | undefined;
  conversions: number | undefined;
  cost: number | undefined;
  date: string | undefined;
  impressions: number | undefined;
};

function gaqlDate(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}

function toNumber(value: string | undefined): number | undefined {
  if (value === undefined || value.length === 0) return undefined;
  const parsed = Number.parseFloat(value);

  return Number.isFinite(parsed) ? parsed : undefined;
}

function toCost(micros: string | undefined): number | undefined {
  const parsed = toNumber(micros);

  return parsed === undefined ? undefined : parsed / MICROS_PER_UNIT;
}

function normalizeLookbackDays(days: number | undefined): number {
  const value = typeof days === "number" && Number.isFinite(days) ? days : 7;

  return Math.max(1, Math.min(90, Math.trunc(value)));
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
