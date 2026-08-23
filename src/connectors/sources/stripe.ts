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

type StripeConfig = {
  enabled?: boolean;
  eventTypes?: string[];
  lookbackHours?: number;
  maxEvents?: number;
};

type StripeListResponse = {
  data?: {
    id?: string;
    created?: number;
    livemode?: boolean;
    type?: string;
  }[];
  has_more?: boolean;
};

const STRIPE_API_BASE_URL = "https://api.stripe.com";

const definition: ConnectorDefinition = {
  backend: "direct-api",
  description:
    "Fetches recent Stripe account events (charges, invoices, subscriptions, payouts) through the Events API.",
  displayName: "Stripe",
  id: "stripe",
  mode: "personal",
  requiredEnv: ["STRIPE_SECRET_KEY"],
  supportsAgenticDiscovery: false,
};

export function createStripeConnector(): ConnectorRuntime {
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
    ...(await readConnectorConfig<StripeConfig>("stripe", {
      enabled: true,
      eventTypes: [],
      lookbackHours: 24,
      maxEvents: 200,
    })),
    ...((options.connectorConfig ?? {}) as StripeConfig),
  };
  const state = await readConnectorState("stripe");
  const warnings: string[] = [];
  const rawFiles: string[] = [];

  if (!config.enabled) {
    return finishStripeRun({
      message: `Stripe connector is not enabled. Set enabled=true in ${openWikiConnectorsDisplayPath}/stripe/config.json.`,
      rawFiles,
      runId,
      state,
      status: "skipped",
      warnings,
    });
  }

  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (typeof secretKey !== "string" || secretKey.trim().length === 0) {
    return finishStripeRun({
      message:
        "STRIPE_SECRET_KEY is not set. Create a restricted API key with Event read permission.",
      rawFiles,
      runId,
      state,
      status: "error",
      warnings,
    });
  }
  // Stripe event timestamps are second-resolution Unix epoch seconds. A prior
  // run's high-water mark resumes the stream; an explicit windowHours override
  // re-opens a bounded window instead.
  const lookbackHours = normalizeLookbackHours(
    options.windowHours ?? config.lookbackHours,
  );
  const cursorSeconds = parseCursorSeconds(state.latestIds?.events);
  const createdGte =
    options.windowHours === undefined && cursorSeconds !== null
      ? cursorSeconds
      : Math.floor(Date.now() / 1000) - lookbackHours * 60 * 60;
  const maxEvents = normalizeMaxEvents(options.limit ?? config.maxEvents);

  try {
    const listing = await listRecentEvents(secretKey.trim(), {
      createdGte,
      eventTypes: config.eventTypes ?? [],
      maxEvents,
    });

    rawFiles.push(
      await writeRawJson("stripe", runId, "stripe-events.json", {
        createdGte: new Date(createdGte * 1000).toISOString(),
        eventCount: listing.events.length,
        events: listing.events,
        fetchedAt: new Date().toISOString(),
        instanceId: options.instanceId,
        lookbackHours,
      }),
    );

    // Advance the high-water mark only when the full requested range was
    // drained; a capped run must resume from its original start time so
    // unreturned older events are never skipped.
    const latestEventSeconds = listing.drained
      ? listing.events.reduce((latest, event) => {
          const createdSeconds = Math.floor(
            new Date(event.createdAt).getTime() / 1000,
          );

          return Number.isFinite(createdSeconds) && createdSeconds > latest
            ? createdSeconds
            : latest;
        }, 0)
      : 0;

    return finishStripeRun({
      message: `Fetched ${listing.events.length} Stripe event${
        listing.events.length === 1 ? "" : "s"
      } over a ${lookbackHours}h lookback.`,
      rawFiles,
      runId,
      state,
      status: "success",
      warnings,
      ...(latestEventSeconds > 0
        ? { latestIds: { events: String(latestEventSeconds) } }
        : {}),
    });
  } catch (error) {
    warnings.push(`events: ${getErrorMessage(error)}`);
    return finishStripeRun({
      message: `Stripe ingestion failed: ${getErrorMessage(error)}`,
      rawFiles,
      runId,
      state,
      status: "error",
      warnings,
    });
  }
}

async function finishStripeRun({
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
    "stripe",
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
    connectorId: "stripe",
    message,
    rawFiles,
    runId,
    statePath: `${openWikiConnectorsDisplayPath}/stripe/state.json`,
    status,
    warnings,
  };
}

/**
 * Lists recent events oldest-first up to the configured maximum, following
 * `has_more` pagination until either the page budget or the event cap is hit.
 */
async function listRecentEvents(
  secretKey: string,
  listOptions: {
    createdGte: number;
    eventTypes: string[];
    maxEvents: number;
  },
): Promise<{ drained: boolean; events: StripeEvent[] }> {
  const events: StripeEvent[] = [];
  let startingAfter: string | undefined;
  let drained = false;

  while (!drained && events.length < listOptions.maxEvents) {
    const url = new URL("/v1/events", STRIPE_API_BASE_URL);
    url.searchParams.set("created[gte]", String(listOptions.createdGte));
    url.searchParams.set("limit", "100");
    if (listOptions.eventTypes.length > 0) {
      for (const eventType of listOptions.eventTypes) {
        url.searchParams.append("types[]", eventType);
      }
    }
    if (startingAfter !== undefined) {
      url.searchParams.set("starting_after", startingAfter);
    }

    const response = await fetchWithResilience(url, {
      headers: {
        Authorization: `Bearer ${secretKey}`,
      },
    });

    if (!response.ok) {
      throw new Error(
        `Stripe request failed: ${response.status} ${response.statusText}`,
      );
    }

    const payload = (await response.json()) as StripeListResponse;
    for (const event of payload.data ?? []) {
      if (
        typeof event.id !== "string" ||
        typeof event.type !== "string" ||
        typeof event.created !== "number"
      ) {
        continue;
      }
      events.push({
        createdAt: new Date(event.created * 1000).toISOString(),
        id: event.id,
        livemode: event.livemode === true,
        type: event.type,
      });
    }

    if (payload.has_more === true && (payload.data?.length ?? 0) > 0) {
      const [lastEvent] = (payload.data ?? []).slice(-1);
      startingAfter =
        typeof lastEvent?.id === "string" ? lastEvent.id : undefined;
      if (startingAfter === undefined) {
        drained = true;
      }
    } else {
      drained = true;
    }
  }

  return {
    drained,
    events: events.slice(0, listOptions.maxEvents),
  };
}

type StripeEvent = {
  createdAt: string;
  id: string;
  livemode: boolean;
  type: string;
};

function normalizeLookbackHours(windowHours: number | undefined): number {
  const hours =
    typeof windowHours === "number" && Number.isFinite(windowHours)
      ? windowHours
      : 24;

  return Math.max(1, Math.min(720, Math.trunc(hours)));
}

/**
 * Reads the stored per-stream high-water mark as epoch seconds.
 *
 * @param cursor - Stored cursor string, when a prior run recorded one.
 * @returns Cursor seconds, or `null` when absent or malformed.
 */
function parseCursorSeconds(cursor: string | undefined): number | null {
  if (cursor === undefined || !/^\d+$/u.test(cursor)) return null;
  const parsed = Number.parseInt(cursor, 10);

  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function normalizeMaxEvents(maxEvents: number | undefined): number {
  const limit =
    typeof maxEvents === "number" && Number.isFinite(maxEvents)
      ? maxEvents
      : 200;

  return Math.max(1, Math.min(1000, Math.trunc(limit)));
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
