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
  ConnectorArtifactRecord,
  ConnectorDefinition,
  ConnectorIngestOptions,
  ConnectorIngestResult,
  ConnectorRuntime,
} from "../types.js";

type MetaAdsConfig = {
  datePreset?:
    "last_14d" | "last_28d" | "last_30d" | "last_7d" | "today" | "yesterday";
  enabled?: boolean;
};

type MetaInsightsResponse = {
  data?: {
    campaign_id?: string;
    campaign_name?: string;
    clicks?: string;
    cpc?: string;
    cpm?: string;
    impressions?: string;
    spend?: string;
  }[];
};

type MetaPaging = { next?: string };

const GRAPH_API_BASE_URL = "https://graph.facebook.com";
const GRAPH_API_VERSION = "v21.0";

const definition: ConnectorDefinition = {
  backend: "direct-api",
  description:
    "Fetches recent Meta Ads campaign insights (spend, impressions, clicks) through the Marketing API.",
  displayName: "Meta Ads",
  id: "meta-ads",
  mode: "personal",
  requiredEnv: ["META_ACCESS_TOKEN", "META_AD_ACCOUNT_ID"],
  supportsAgenticDiscovery: false,
};

export function createMetaAdsConnector(): ConnectorRuntime {
  return {
    ...definition,
    artifactRecords: readMetaAdsRecordEpisodes,
    ingest,
  };
}

/**
 * Splits a parsed raw dump into per-campaign episodes.
 *
 * @param parsed - Parsed meta-insights.json content.
 * @returns One episode per campaign, or `null` when the shape does not match.
 */
function readMetaAdsRecordEpisodes(
  parsed: unknown,
): ConnectorArtifactRecord[] | null {
  if (!isRecord(parsed) || !Array.isArray(parsed.rows)) return null;
  const rows: unknown[] = parsed.rows;

  // Insight rows are windowed aggregates without a source clock; the empty
  // event time defers to the artifact's fetchedAt stamp.
  return rows.flatMap((row) => {
    if (!isRecord(row) || typeof row.campaignId !== "string") return [];

    return [
      {
        content: JSON.stringify(row),
        eventTimeIso: "",
        sourceRef: `meta-insights.json#${row.campaignId}`,
      },
    ];
  });
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

async function ingest(
  options: ConnectorIngestOptions = {},
): Promise<ConnectorIngestResult> {
  const runId = createRunId();
  const config = {
    ...(await readConnectorConfig<MetaAdsConfig>("meta-ads", {
      datePreset: "last_7d",
      enabled: true,
    })),
    ...((options.connectorConfig ?? {}) as MetaAdsConfig),
  };
  const state = await readConnectorState("meta-ads");
  const warnings: string[] = [];
  const rawFiles: string[] = [];

  if (!config.enabled) {
    return finishMetaAdsRun({
      message: `Meta Ads connector is not enabled. Set enabled=true in ${openWikiConnectorsDisplayPath}/meta-ads/config.json.`,
      rawFiles,
      runId,
      state,
      status: "skipped",
      warnings,
    });
  }

  const accessToken = process.env.META_ACCESS_TOKEN;
  const accountId = process.env.META_AD_ACCOUNT_ID;
  if (
    typeof accessToken !== "string" ||
    accessToken.trim().length === 0 ||
    typeof accountId !== "string" ||
    accountId.trim().length === 0
  ) {
    return finishMetaAdsRun({
      message:
        "META_ACCESS_TOKEN or META_AD_ACCOUNT_ID is not set. Provide a System User token with ads_read and the numeric account id (without the act_ prefix).",
      rawFiles,
      runId,
      state,
      status: "error",
      warnings,
    });
  }

  // An explicit runtime window becomes a concrete time range; otherwise the
  // configured (or default) date preset is used.
  const datePreset = normalizeDatePreset(config.datePreset);
  const timeRange =
    options.windowHours === undefined
      ? undefined
      : {
          since: isoDaysAgo(Math.ceil(options.windowHours / 24)),
          until: todayIsoDate(),
        };

  try {
    const campaigns = await listCampaignInsights(
      accessToken.trim(),
      accountId.trim(),
      timeRange ?? datePreset,
    );

    rawFiles.push(
      await writeRawJson("meta-ads", runId, "meta-insights.json", {
        datePreset: timeRange === undefined ? datePreset : undefined,
        fetchedAt: new Date().toISOString(),
        instanceId: options.instanceId,
        rows: campaigns,
        timeRange,
      }),
    );

    return finishMetaAdsRun({
      message: `Fetched insights for ${campaigns.length} campaign${
        campaigns.length === 1 ? "" : "s"
      } (${timeRange === undefined ? datePreset : `${timeRange.since}..${timeRange.until}`}).`,
      rawFiles,
      runId,
      state,
      status: "success",
      warnings,
    });
  } catch (error) {
    warnings.push(`insights: ${getErrorMessage(error)}`);
    return finishMetaAdsRun({
      message: `Meta Ads ingestion failed: ${getErrorMessage(error)}`,
      rawFiles,
      runId,
      state,
      status: "error",
      warnings,
    });
  }
}

async function finishMetaAdsRun({
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
    "meta-ads",
    updateStateWithRun(state, {
      at: new Date().toISOString(),
      rawFiles,
      runId,
      status,
      warnings,
    }),
  );

  return {
    connectorId: "meta-ads",
    message,
    rawFiles,
    runId,
    statePath: `${openWikiConnectorsDisplayPath}/meta-ads/state.json`,
    status,
    warnings,
  };
}

/**
 * Fetches campaign-level insights for one date preset or explicit time range,
 * following Graph API paging cursors until exhausted.
 */
async function listCampaignInsights(
  accessToken: string,
  adAccountId: string,
  reportingWindow: NonNullable<MetaAdsConfig["datePreset"]> | MetaTimeRange,
): Promise<CampaignInsight[]> {
  const insights: CampaignInsight[] = [];
  let pageUrl: URL | undefined = new URL(
    `/${GRAPH_API_VERSION}/act_${adAccountId}/insights`,
    GRAPH_API_BASE_URL,
  );
  if (typeof reportingWindow === "string") {
    pageUrl.searchParams.set("date_preset", reportingWindow);
  } else {
    pageUrl.searchParams.set("time_range", JSON.stringify(reportingWindow));
  }
  pageUrl.searchParams.set("level", "campaign");
  pageUrl.searchParams.set(
    "fields",
    "campaign_id,campaign_name,impressions,clicks,spend,cpc,cpm",
  );

  while (pageUrl !== undefined) {
    const response = await fetchWithResilience(pageUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      throw new Error(
        `Meta Ads request failed: ${response.status} ${response.statusText}`,
      );
    }

    const payload = (await response.json()) as {
      data?: MetaInsightsResponse["data"];
      paging?: MetaPaging;
    };
    for (const row of payload.data ?? []) {
      if (typeof row.campaign_id !== "string") continue;
      insights.push({
        campaignId: row.campaign_id,
        campaignName: row.campaign_name,
        clicks: toNumber(row.clicks),
        cpc: toNumber(row.cpc),
        cpm: toNumber(row.cpm),
        impressions: toNumber(row.impressions),
        spend: toNumber(row.spend),
      });
    }

    pageUrl =
      typeof payload.paging?.next === "string" && payload.paging.next.length > 0
        ? new URL(payload.paging.next)
        : undefined;
  }

  return insights;
}

type MetaTimeRange = { since: string; until: string };

type CampaignInsight = {
  campaignId: string;
  campaignName: string | undefined;
  clicks: number | undefined;
  cpc: number | undefined;
  cpm: number | undefined;
  impressions: number | undefined;
  spend: number | undefined;
};

function toNumber(value: string | undefined): number | undefined {
  if (value === undefined || value.length === 0) return undefined;
  const parsed = Number.parseFloat(value);

  return Number.isFinite(parsed) ? parsed : undefined;
}

const DATE_PRESETS = [
  "last_14d",
  "last_28d",
  "last_30d",
  "last_7d",
  "today",
  "yesterday",
] as const satisfies readonly NonNullable<MetaAdsConfig["datePreset"]>[];

function normalizeDatePreset(
  datePreset: MetaAdsConfig["datePreset"],
): NonNullable<MetaAdsConfig["datePreset"]> {
  return DATE_PRESETS.find((preset) => preset === datePreset) ?? "last_7d";
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
