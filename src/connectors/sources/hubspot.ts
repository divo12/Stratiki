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

type HubSpotConfig = {
  enabled?: boolean;
  includeCompanies?: boolean;
  includeContacts?: boolean;
  includeDeals?: boolean;
  maxRecordsPerObject?: number;
};

type CrmObjectType = "companies" | "contacts" | "deals";

type HubSpotRecord = {
  id: string;
  properties: Record<string, string | undefined>;
};

type SearchResponse = {
  results?: { id?: string; properties?: Record<string, unknown> }[];
};

// The property set is deliberately small: enough to identify and summarize a
// record without pulling large custom-property payloads.
const OBJECT_PROPERTIES: Record<CrmObjectType, string[]> = {
  companies: ["domain", "hs_lastmodifieddate", "industry", "name"],
  contacts: [
    "email",
    "firstname",
    "hs_lastmodifieddate",
    "jobtitle",
    "lastname",
  ],
  deals: [
    "amount",
    "closedate",
    "dealname",
    "dealstage",
    "hs_lastmodifieddate",
    "pipeline",
  ],
};

const HUBSPOT_API_BASE_URL = "https://api.hubapi.com";

const definition: ConnectorDefinition = {
  backend: "direct-api",
  description:
    "Fetches recently modified CRM records (deals, companies, contacts) from HubSpot through the CRM search API.",
  displayName: "HubSpot",
  id: "hubspot",
  mode: "personal",
  requiredEnv: ["HUBSPOT_TOKEN"],
  supportsAgenticDiscovery: false,
};

export function createHubSpotConnector(): ConnectorRuntime {
  return {
    ...definition,
    artifactEventTime: (parsed) =>
      maxIsoString(readHubSpotModifiedTimes(parsed)),
    ingest,
  };
}

/**
 * Reads every record's `hs_lastmodifieddate` from a parsed raw dump.
 *
 * @param parsed - Parsed hubspot-records.json content.
 * @returns Record modification timestamps, when the dump shape matches.
 */
function readHubSpotModifiedTimes(parsed: unknown): (string | undefined)[] {
  if (!isRecord(parsed) || !isRecord(parsed.objects)) return [];

  return Object.values(parsed.objects).flatMap((objectRecords) =>
    Array.isArray(objectRecords)
      ? objectRecords.flatMap((record) => {
          if (!isRecord(record) || !isRecord(record.properties)) return [];
          const modified = record.properties.hs_lastmodifieddate;

          return typeof modified === "string" ? [modified] : [];
        })
      : [],
  );
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
    ...(await readConnectorConfig<HubSpotConfig>("hubspot", {
      enabled: true,
      includeCompanies: true,
      includeContacts: true,
      includeDeals: true,
      maxRecordsPerObject: 50,
    })),
    ...((options.connectorConfig ?? {}) as HubSpotConfig),
  };
  const state = await readConnectorState("hubspot");
  const warnings: string[] = [];
  const rawFiles: string[] = [];

  if (!config.enabled) {
    return {
      connectorId: "hubspot",
      message: `HubSpot connector is not enabled. Set enabled=true in ${openWikiConnectorsDisplayPath}/hubspot/config.json.`,
      rawFiles,
      runId,
      statePath: `${openWikiConnectorsDisplayPath}/hubspot/state.json`,
      status: "skipped",
      warnings,
    };
  }

  const token = process.env.HUBSPOT_TOKEN;
  if (typeof token !== "string" || token.trim().length === 0) {
    return await finishHubSpotRun({
      message:
        "HUBSPOT_TOKEN is not set. Create a HubSpot private app token with crm.objects read scopes.",
      rawFiles,
      runId,
      state,
      status: "error",
      warnings,
    });
  }

  const limit = normalizeLimit(options.limit, config.maxRecordsPerObject);
  const windowHours = normalizeWindowHours(options.windowHours) ?? 24;
  // A prior run's high-water mark resumes the stream; an explicit windowHours
  // override re-opens a bounded window instead.
  const priorCursor =
    options.windowHours === undefined
      ? parseCursorMs(state.latestIds?.records)
      : null;
  const sinceMs = priorCursor ?? Date.now() - windowHours * 60 * 60 * 1000;

  const objectTypes = (["deals", "companies", "contacts"] as const).filter(
    (objectType) => {
      if (objectType === "deals") {
        return config.includeDeals !== false;
      }
      if (objectType === "companies") {
        return config.includeCompanies !== false;
      }

      return config.includeContacts !== false;
    },
  );

  const objects: Partial<Record<CrmObjectType, HubSpotRecord[]>> = {};
  for (const objectType of objectTypes) {
    try {
      objects[objectType] = await searchRecentlyModified(
        token.trim(),
        objectType,
        {
          limit,
          sinceMs,
        },
      );
    } catch (error) {
      warnings.push(`${objectType}: ${getErrorMessage(error)}`);
    }
  }

  rawFiles.push(
    await writeRawJson("hubspot", runId, "hubspot-records.json", {
      fetchedAt: new Date().toISOString(),
      instanceId: options.instanceId,
      objects,
      since: new Date(sinceMs).toISOString(),
      windowHours,
    }),
  );

  const recordCount = Object.values(objects).reduce(
    (total, records) => total + (records?.length ?? 0),
    0,
  );

  // Persist the newest hs_lastmodifieddate actually returned so the next run
  // resumes forward; when nothing newer exists, the prior cursor is retained.
  const newestModified = Object.values(objects)
    .flat()
    .map((record) => record?.properties.hs_lastmodifieddate)
    .filter((value): value is string => typeof value === "string")
    .sort()
    .at(-1);
  const newestModifiedMs =
    newestModified !== undefined ? Date.parse(newestModified) : Number.NaN;
  const nextCursorMs =
    Number.isFinite(newestModifiedMs) && newestModifiedMs > sinceMs
      ? newestModifiedMs
      : undefined;

  return await finishHubSpotRun({
    message: `Fetched ${recordCount} HubSpot record${
      recordCount === 1 ? "" : "s"
    } across ${objectTypes.length} object type${
      objectTypes.length === 1 ? "" : "s"
    }.`,
    rawFiles,
    runId,
    state,
    status: "success",
    warnings,
    latestIds:
      nextCursorMs === undefined
        ? undefined
        : { records: new Date(nextCursorMs).toISOString() },
  });
}

async function finishHubSpotRun({
  message,
  rawFiles,
  runId,
  state,
  status,
  warnings,
  latestIds,
}: {
  message: string;
  rawFiles: string[];
  runId: string;
  state: Awaited<ReturnType<typeof readConnectorState>>;
  status: ConnectorIngestResult["status"];
  warnings: string[];
  latestIds?: Record<string, string>;
}): Promise<ConnectorIngestResult> {
  await writeConnectorState(
    "hubspot",
    updateStateWithRun(
      state,
      {
        at: new Date().toISOString(),
        rawFiles,
        runId,
        status,
        warnings,
      },
      latestIds,
    ),
  );

  return {
    connectorId: "hubspot",
    message,
    rawFiles,
    runId,
    statePath: `${openWikiConnectorsDisplayPath}/hubspot/state.json`,
    status,
    warnings,
  };
}

/**
 * Runs one search per object type against the CRM search endpoint, filtering
 * on `hs_lastmodifieddate` so repeated runs only see what changed in-window.
 */
async function searchRecentlyModified(
  token: string,
  objectType: CrmObjectType,
  searchOptions: { limit: number; sinceMs: number },
): Promise<HubSpotRecord[]> {
  const url = new URL(
    `/crm/v3/objects/${objectType}/search`,
    HUBSPOT_API_BASE_URL,
  );
  const response = await fetchWithResilience(url, {
    body: JSON.stringify({
      filterGroups: [
        {
          filters: [
            {
              operator: "GTE",
              propertyName: "hs_lastmodifieddate",
              value: String(searchOptions.sinceMs),
            },
          ],
        },
      ],
      limit: Math.min(searchOptions.limit, 100),
      properties: OBJECT_PROPERTIES[objectType],
      sorts: [{ direction: "DESCENDING", propertyName: "hs_lastmodifieddate" }],
    }),
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    method: "POST",
  });

  if (!response.ok) {
    throw new Error(
      `HubSpot request failed: ${response.status} ${response.statusText}`,
    );
  }

  const payload = (await response.json()) as SearchResponse;

  return (payload.results ?? []).flatMap((result) => {
    if (typeof result.id !== "string" || result.id.length === 0) {
      return [];
    }

    return [
      {
        id: result.id,
        properties: mapProperties(result.properties ?? {}),
      },
    ];
  });
}

function mapProperties(
  raw: Record<string, unknown>,
): Record<string, string | undefined> {
  const mapped: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(raw)) {
    // HubSpot CRM properties are string-valued; anything else is dropped
    // rather than stringified.
    mapped[key] = typeof value === "string" ? value : undefined;
  }

  return mapped;
}

function normalizeLimit(
  optionLimit: number | undefined,
  configLimit: number | undefined,
): number {
  const limit = optionLimit ?? configLimit ?? 50;

  return Math.max(1, Math.min(100, Math.trunc(limit)));
}

function normalizeWindowHours(windowHours: number | undefined): number | null {
  if (typeof windowHours !== "number" || !Number.isFinite(windowHours)) {
    return null;
  }

  return Math.max(1, Math.min(168, Math.trunc(windowHours)));
}

/**
 * Reads the stored per-stream high-water mark as epoch milliseconds.
 *
 * @param cursor - Stored cursor string, when a prior run recorded one.
 * @returns Cursor milliseconds, or `null` when absent or malformed.
 */
function parseCursorMs(cursor: string | undefined): number | null {
  if (cursor === undefined || cursor.length === 0) return null;
  const parsed = Date.parse(cursor);

  return Number.isFinite(parsed) ? parsed : null;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
