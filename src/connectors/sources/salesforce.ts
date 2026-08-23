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
  ConnectorArtifactRecord,
  ConnectorDefinition,
  ConnectorIngestOptions,
  ConnectorIngestResult,
  ConnectorRuntime,
} from "../types.js";

type SalesforceConfig = {
  enabled?: boolean;
  includeAccounts?: boolean;
  includeCases?: boolean;
  includeContacts?: boolean;
  includeOpportunities?: boolean;
  lookbackHours?: number;
};

type SalesforceObjectType = "Account" | "Case" | "Contact" | "Opportunity";

type SalesforceRecord = {
  Id?: string;
  LastModifiedDate?: string;
  attributes?: { type?: string };
} & Record<string, unknown>;

type SalesforceQueryResponse = {
  records?: SalesforceRecord[];
  done?: boolean;
};

// One compact field list per object: identity, audit timestamp, and the small
// set of fields that make a record recognizable without pulling full payloads.
const OBJECT_QUERIES: Record<SalesforceObjectType, string> = {
  Account:
    "SELECT Id, Name, Industry, LastModifiedDate FROM Account WHERE LastModifiedDate >= {since}",
  Case: "SELECT Id, Subject, Status, LastModifiedDate FROM Case WHERE LastModifiedDate >= {since}",
  Contact:
    "SELECT Id, Email, FirstName, LastName, LastModifiedDate FROM Contact WHERE LastModifiedDate >= {since}",
  Opportunity:
    "SELECT Id, Name, StageName, CloseDate, LastModifiedDate FROM Opportunity WHERE LastModifiedDate >= {since}",
};

const SALESFORCE_API_VERSION = "v62.0";

const definition: ConnectorDefinition = {
  backend: "direct-api",
  description:
    "Fetches recently modified Salesforce records (accounts, contacts, opportunities, cases) through SOQL.",
  displayName: "Salesforce",
  id: "salesforce",
  mode: "personal",
  requiredEnv: ["SALESFORCE_ACCESS_TOKEN", "SALESFORCE_INSTANCE_URL"],
  supportsAgenticDiscovery: false,
};

export function createSalesforceConnector(): ConnectorRuntime {
  return {
    ...definition,
    artifactEventTime: (parsed) =>
      maxIsoString(readSalesforceModifiedTimes(parsed)),
    artifactRecords: readSalesforceRecordEpisodes,
    ingest,
  };
}

/**
 * Splits a parsed raw dump into per-record episodes across all object types.
 *
 * @param parsed - Parsed salesforce-records.json content.
 * @returns One episode per CRM record, or `null` when the shape does not match.
 */
function readSalesforceRecordEpisodes(
  parsed: unknown,
): ConnectorArtifactRecord[] | null {
  if (!isRecord(parsed) || !isRecord(parsed.records)) return null;

  return Object.entries(parsed.records).flatMap(([objectType, records]) =>
    Array.isArray(records)
      ? records.flatMap((record) => {
          if (
            !isRecord(record) ||
            typeof record.Id !== "string" ||
            typeof record.LastModifiedDate !== "string"
          ) {
            return [];
          }

          return [
            {
              content: JSON.stringify(record),
              eventTimeIso: record.LastModifiedDate,
              sourceRef: `${objectType}#${record.Id}`,
            },
          ];
        })
      : [],
  );
}

/**
 * Reads every record's source modification time from a parsed raw dump.
 *
 * @param parsed - Parsed salesforce-records.json content.
 * @returns Record modification timestamps, when the dump shape matches.
 */
function readSalesforceModifiedTimes(parsed: unknown): (string | undefined)[] {
  if (!isRecord(parsed) || !isRecord(parsed.records)) return [];

  return Object.values(parsed.records).flatMap((objectRecords) =>
    Array.isArray(objectRecords)
      ? objectRecords.flatMap((record) =>
          isRecord(record) && typeof record.LastModifiedDate === "string"
            ? [record.LastModifiedDate]
            : [],
        )
      : [],
  );
}

async function ingest(
  options: ConnectorIngestOptions = {},
): Promise<ConnectorIngestResult> {
  const runId = createRunId();
  const config = {
    ...(await readConnectorConfig<SalesforceConfig>("salesforce", {
      enabled: true,
      includeAccounts: true,
      includeCases: true,
      includeContacts: true,
      includeOpportunities: true,
      lookbackHours: 24,
    })),
    ...((options.connectorConfig ?? {}) as SalesforceConfig),
  };
  const state = await readConnectorState("salesforce");
  const warnings: string[] = [];
  const rawFiles: string[] = [];

  if (!config.enabled) {
    return finishSalesforceRun({
      message: `Salesforce connector is not enabled. Set enabled=true in ${openWikiConnectorsDisplayPath}/salesforce/config.json.`,
      rawFiles,
      runId,
      state,
      status: "skipped",
      warnings,
    });
  }

  const accessToken = process.env.SALESFORCE_ACCESS_TOKEN;
  const instanceUrl = process.env.SALESFORCE_INSTANCE_URL;
  if (
    typeof accessToken !== "string" ||
    accessToken.trim().length === 0 ||
    typeof instanceUrl !== "string" ||
    instanceUrl.trim().length === 0
  ) {
    return finishSalesforceRun({
      message:
        "SALESFORCE_ACCESS_TOKEN or SALESFORCE_INSTANCE_URL is not set. Provide OAuth credentials with api scope and the instance URL (https://<org>.my.salesforce.com).",
      rawFiles,
      runId,
      state,
      status: "error",
      warnings,
    });
  }

  const lookbackHours = normalizeLookbackHours(
    options.windowHours ?? config.lookbackHours,
  );
  // A prior run's high-water mark resumes the stream; an explicit windowHours
  // override re-opens a bounded window instead.
  const cursorSince = parseCursorIso(state.latestIds?.records);
  const sinceIso =
    options.windowHours === undefined && cursorSince !== null
      ? cursorSince
      : new Date(Date.now() - lookbackHours * 60 * 60 * 1000).toISOString();

  const includedObjects = (
    [
      ["Account", config.includeAccounts !== false],
      ["Contact", config.includeContacts !== false],
      ["Opportunity", config.includeOpportunities !== false],
      ["Case", config.includeCases !== false],
    ] as const satisfies readonly (readonly [SalesforceObjectType, boolean])[]
  )
    .filter(([, included]) => included)
    .map(([objectType]) => objectType);

  const records: Partial<
    Record<SalesforceObjectType, Record<string, unknown>[]>
  > = {};
  for (const objectType of includedObjects) {
    try {
      records[objectType] = await runSoqlQuery(
        accessToken.trim(),
        instanceUrl.trim(),
        OBJECT_QUERIES[objectType].replace("{since}", sinceIso),
      );
    } catch (error) {
      warnings.push(`${objectType}: ${getErrorMessage(error)}`);
    }
  }

  rawFiles.push(
    await writeRawJson("salesforce", runId, "salesforce-records.json", {
      fetchedAt: new Date().toISOString(),
      instanceId: options.instanceId,
      lookbackHours,
      records,
      since: sinceIso,
    }),
  );

  const recordCount = Object.values(records).reduce(
    (total, objectRecords) => total + (objectRecords?.length ?? 0),
    0,
  );

  // Persist the newest LastModifiedDate actually returned so the next run
  // resumes forward; when nothing newer exists, the prior cursor is retained.
  const newestModified = Object.values(records)
    .flat()
    .map((record) => record.LastModifiedDate)
    .filter((value): value is string => typeof value === "string")
    .sort()
    .at(-1);
  const priorCursor =
    options.windowHours === undefined
      ? parseCursorIso(state.latestIds?.records)
      : null;
  const nextCursor =
    newestModified !== undefined &&
    (priorCursor === null || newestModified > priorCursor) &&
    newestModified > sinceIso
      ? newestModified
      : undefined;

  return finishSalesforceRun({
    message: `Fetched ${recordCount} Salesforce record${
      recordCount === 1 ? "" : "s"
    } across ${includedObjects.length} object type${
      includedObjects.length === 1 ? "" : "s"
    }.`,
    rawFiles,
    runId,
    state,
    status: warnings.length > 0 && recordCount === 0 ? "error" : "success",
    warnings,
    latestIds: nextCursor !== undefined ? { records: nextCursor } : undefined,
  });
}

async function finishSalesforceRun({
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
    "salesforce",
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
    connectorId: "salesforce",
    message,
    rawFiles,
    runId,
    statePath: `${openWikiConnectorsDisplayPath}/salesforce/state.json`,
    status,
    warnings,
  };
}

/**
 * Runs one SOQL statement and returns plain records. Pagination beyond the
 * first page is intentionally out of scope for the recent-changes snapshot.
 */
async function runSoqlQuery(
  accessToken: string,
  instanceUrl: string,
  soql: string,
): Promise<Record<string, unknown>[]> {
  const url = new URL(
    `/services/data/${SALESFORCE_API_VERSION}/query`,
    instanceUrl,
  );
  url.searchParams.set("q", soql);

  const response = await fetchWithResilience(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(
      `Salesforce request failed: ${response.status} ${response.statusText}`,
    );
  }

  const payload = (await response.json()) as SalesforceQueryResponse;

  return (payload.records ?? []).map((record) => {
    const fields: Record<string, unknown> = { ...record };
    delete fields.attributes;
    return fields;
  });
}

function normalizeLookbackHours(windowHours: number | undefined): number {
  const hours =
    typeof windowHours === "number" && Number.isFinite(windowHours)
      ? windowHours
      : 24;

  return Math.max(1, Math.min(168, Math.trunc(hours)));
}

/**
 * Reads the stored per-stream high-water mark as an ISO timestamp.
 *
 * @param cursor - Stored cursor string, when a prior run recorded one.
 * @returns Cursor ISO timestamp, or `null` when absent or malformed.
 */
function parseCursorIso(cursor: string | undefined): string | null {
  if (cursor === undefined || cursor.length === 0) return null;
  const parsed = Date.parse(cursor);

  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
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
