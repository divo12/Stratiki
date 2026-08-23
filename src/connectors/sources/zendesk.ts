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

type ZendeskConfig = {
  enabled?: boolean;
  lookbackHours?: number;
  maxTickets?: number;
};

type ZendeskIncrementalResponse = {
  end_of_stream?: boolean;
  next_page?: string;
  tickets?: {
    created_at?: string;
    description?: string;
    id?: number;
    priority?: string;
    status?: string;
    subject?: string;
    updated_at?: string;
    url?: string;
  }[];
};

type ZendeskTicket = {
  createdAt: string | undefined;
  description: string | undefined;
  id: number;
  priority: string | undefined;
  status: string | undefined;
  subject: string | undefined;
  updatedAt: string | undefined;
};

const MAX_WINDOW_HOURS = 24;

const definition: ConnectorDefinition = {
  backend: "direct-api",
  description:
    "Fetches recently created or updated Zendesk tickets through the incremental tickets API.",
  displayName: "Zendesk",
  id: "zendesk",
  mode: "personal",
  requiredEnv: ["ZENDESK_EMAIL", "ZENDESK_API_TOKEN", "ZENDESK_SUBDOMAIN"],
  supportsAgenticDiscovery: false,
};

export function createZendeskConnector(): ConnectorRuntime {
  return {
    ...definition,
    artifactEventTime: (parsed) => maxIsoString(readZendeskTicketTimes(parsed)),
    ingest,
  };
}

/**
 * Reads every ticket's source update time from a parsed raw dump.
 *
 * @param parsed - Parsed zendesk-tickets.json content.
 * @returns Ticket update timestamps, when the dump shape matches.
 */
function readZendeskTicketTimes(parsed: unknown): (string | undefined)[] {
  if (!isRecord(parsed) || !Array.isArray(parsed.tickets)) return [];

  return parsed.tickets.flatMap((ticket) =>
    isRecord(ticket) && typeof ticket.updatedAt === "string"
      ? [ticket.updatedAt]
      : [],
  );
}

async function ingest(
  options: ConnectorIngestOptions = {},
): Promise<ConnectorIngestResult> {
  const runId = createRunId();
  const config = {
    ...(await readConnectorConfig<ZendeskConfig>("zendesk", {
      enabled: true,
      lookbackHours: 24,
      maxTickets: 200,
    })),
    ...((options.connectorConfig ?? {}) as ZendeskConfig),
  };
  const state = await readConnectorState("zendesk");
  const warnings: string[] = [];
  const rawFiles: string[] = [];

  if (!config.enabled) {
    return finishZendeskRun({
      message: `Zendesk connector is not enabled. Set enabled=true in ${openWikiConnectorsDisplayPath}/zendesk/config.json.`,
      rawFiles,
      runId,
      state,
      status: "skipped",
      warnings,
    });
  }

  const email = process.env.ZENDESK_EMAIL;
  const apiToken = process.env.ZENDESK_API_TOKEN;
  const subdomain = process.env.ZENDESK_SUBDOMAIN;
  if (
    typeof email !== "string" ||
    email.trim().length === 0 ||
    typeof apiToken !== "string" ||
    apiToken.trim().length === 0 ||
    typeof subdomain !== "string" ||
    subdomain.trim().length === 0
  ) {
    return finishZendeskRun({
      message:
        "ZENDESK_EMAIL, ZENDESK_API_TOKEN, or ZENDESK_SUBDOMAIN is not set. Create an API token for an agent user with read access to tickets.",
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
  const maxTickets = normalizeMaxTickets(options.limit ?? config.maxTickets);
  // The incremental API is cursor-native: resume from the prior run's end
  // time unless an explicit windowHours override re-opens a bounded window.
  const cursorSeconds = parseCursorSeconds(state.latestIds?.tickets);
  const startTime =
    options.windowHours === undefined && cursorSeconds !== null
      ? cursorSeconds
      : Math.floor((Date.now() - lookbackHours * 60 * 60 * 1000) / 1000);

  try {
    const listing = await listRecentTickets(
      buildCredentials(email.trim(), apiToken.trim()),
      subdomain.trim(),
      {
        startTime,
        maxTickets,
      },
    );

    rawFiles.push(
      await writeRawJson("zendesk", runId, "zendesk-tickets.json", {
        fetchedAt: new Date().toISOString(),
        instanceId: options.instanceId,
        startTime: new Date(startTime * 1000).toISOString(),
        ticketCount: listing.tickets.length,
        tickets: listing.tickets,
      }),
    );

    // Advance the incremental cursor only when the stream was fully drained;
    // a capped run must resume from its original start time so capped tickets
    // are never skipped.
    return finishZendeskRun({
      message: `Fetched ${listing.tickets.length} Zendesk ticket${
        listing.tickets.length === 1 ? "" : "s"
      } over a ${lookbackHours}h lookback.`,
      rawFiles,
      runId,
      state,
      status: "success",
      warnings,
      latestIds: listing.drained
        ? { tickets: String(Math.floor(Date.now() / 1000) - 60) }
        : undefined,
    });
  } catch (error) {
    warnings.push(`tickets: ${getErrorMessage(error)}`);
    return finishZendeskRun({
      message: `Zendesk ingestion failed: ${getErrorMessage(error)}`,
      rawFiles,
      runId,
      state,
      status: "error",
      warnings,
    });
  }
}

async function finishZendeskRun({
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
    "zendesk",
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
    connectorId: "zendesk",
    message,
    rawFiles,
    runId,
    statePath: `${openWikiConnectorsDisplayPath}/zendesk/state.json`,
    status,
    warnings,
  };
}

/**
 * Pages through `/incremental/tickets.json` following `next_page` until the
 * stream ends or the ticket cap is reached. Each ticket is trimmed to the
 * compact provenance field set.
 */
async function listRecentTickets(
  credentials: string,
  subdomain: string,
  listOptions: { startTime: number; maxTickets: number },
): Promise<{ drained: boolean; tickets: ZendeskTicket[] }> {
  const tickets: ZendeskTicket[] = [];
  let pageUrl: URL | undefined = new URL(
    `/api/v2/incremental/tickets.json`,
    `https://${subdomain}.zendesk.com`,
  );
  pageUrl.searchParams.set("start_time", String(listOptions.startTime));
  let drained = false;

  while (pageUrl !== undefined && tickets.length < listOptions.maxTickets) {
    const response = await fetchWithResilience(pageUrl, {
      headers: {
        Authorization: `Basic ${credentials}`,
      },
    });

    if (!response.ok) {
      throw new Error(
        `Zendesk request failed: ${response.status} ${response.statusText}`,
      );
    }

    const payload = (await response.json()) as ZendeskIncrementalResponse;
    for (const ticket of payload.tickets ?? []) {
      if (typeof ticket.id !== "number") continue;
      tickets.push({
        createdAt: ticket.created_at,
        description: ticket.description,
        id: ticket.id,
        priority: ticket.priority,
        status: ticket.status,
        subject: ticket.subject,
        updatedAt: ticket.updated_at,
      });
    }

    pageUrl =
      typeof payload.next_page === "string" && payload.next_page.length > 0
        ? new URL(payload.next_page)
        : undefined;
    if (pageUrl === undefined) {
      drained = payload.end_of_stream !== false;
    }
  }

  return {
    drained,
    tickets: tickets.slice(0, listOptions.maxTickets),
  };
}

function buildCredentials(email: string, apiToken: string): string {
  return Buffer.from(`${email}/token:${apiToken}`).toString("base64");
}

function normalizeLookbackHours(windowHours: number | undefined): number {
  const hours =
    typeof windowHours === "number" && Number.isFinite(windowHours)
      ? windowHours
      : 24;

  return Math.max(1, Math.min(MAX_WINDOW_HOURS, Math.trunc(hours)));
}

function normalizeMaxTickets(maxTickets: number | undefined): number {
  const limit =
    typeof maxTickets === "number" && Number.isFinite(maxTickets)
      ? maxTickets
      : 200;

  return Math.max(1, Math.min(1000, Math.trunc(limit)));
}

/**
 * Reads the stored per-stream high-water mark as epoch seconds.
 *
 * @param cursor - Stored cursor string, when a prior run recorded one.
 * @returns Cursor seconds, or `null` when absent or malformed.
 */
function parseCursorSeconds(cursor: string | undefined): number | null {
  if (cursor === undefined || cursor.length === 0) return null;
  const parsed = Number.parseInt(cursor, 10);

  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
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
