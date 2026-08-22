import { homedir } from "node:os";
import path from "node:path";
import { readdir, readFile, stat } from "node:fs/promises";
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

type GranolaConfig = {
  enabled?: boolean;
  includeTranscript?: boolean;
  maxMeetings?: number;
  notesPath?: string;
};

type GranolaMeeting = {
  content?: string;
  createdAt?: string;
  id?: string;
  transcriptExcerpt?: string;
  title?: string;
  updatedAt?: string;
};

/** The Granola desktop app stores its local document cache under this folder. */
const GRANOLA_APP_DIR = path.join(
  homedir(),
  "Library",
  "Application Support",
  "Granola",
);

const definition: ConnectorDefinition = {
  backend: "local-store",
  description:
    "Reads meeting notes and decisions from the local Granola desktop app store (macOS). No account or API key required.",
  displayName: "Granola",
  id: "granola",
  mode: "personal",
  requiredEnv: [],
  supportsAgenticDiscovery: false,
};

export function createGranolaConnector(): ConnectorRuntime {
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
    ...(await readConnectorConfig<GranolaConfig>("granola", {
      enabled: true,
      includeTranscript: false,
      maxMeetings: 30,
      notesPath: undefined,
    })),
    ...((options.connectorConfig ?? {}) as GranolaConfig),
  };
  const state = await readConnectorState("granola");
  const warnings: string[] = [];
  const rawFiles: string[] = [];

  if (!config.enabled) {
    return {
      connectorId: "granola",
      message: `Granola connector is not enabled. Set enabled=true in ${openWikiConnectorsDisplayPath}/granola/config.json.`,
      rawFiles,
      runId,
      statePath: `${openWikiConnectorsDisplayPath}/granola/state.json`,
      status: "skipped",
      warnings,
    };
  }

  // Granola has no public API; its macOS app keeps a JSON document cache on
  // disk. Resolve either an explicit override or scan the default directory.
  const sourcePath =
    typeof config.notesPath === "string" && config.notesPath.trim().length > 0
      ? resolveTilde(config.notesPath.trim())
      : await discoverCacheFile(GRANOLA_APP_DIR, warnings);
  if (sourcePath === null) {
    return await finishGranolaRun({
      message:
        "No Granola document cache found. Install the Granola desktop app, or set notesPath in the granola connector config to its JSON cache file.",
      rawFiles,
      runId,
      state,
      status: "error",
      warnings,
    });
  }

  let meetings: GranolaMeeting[];
  try {
    meetings = parseDocumentCache(await readFile(sourcePath, "utf8"), config, warnings);
  } catch (error) {
    return await finishGranolaRun({
      message: `Failed to read the Granola cache at ${sourcePath}: ${getErrorMessage(error)}`,
      rawFiles,
      runId,
      state,
      status: "error",
      warnings,
    });
  }

  const limit = normalizeLimit(options.limit, config.maxMeetings);
  const windowHours = normalizeWindowHours(options.windowHours);
  const recentMeetings = selectRecentMeetings(meetings, { limit, windowHours });

  rawFiles.push(
    await writeRawJson("granola", runId, "granola-meetings.json", {
      fetchedAt: new Date().toISOString(),
      instanceId: options.instanceId,
      meetings: recentMeetings,
      sourcePath,
      totalParsed: meetings.length,
      windowHours,
    }),
  );

  return await finishGranolaRun({
    message: `Read ${recentMeetings.length} meeting${
      recentMeetings.length === 1 ? "" : "s"
    } from ${sourcePath}.`,
    rawFiles,
    runId,
    state,
    status: "success",
    warnings,
  });
}

async function finishGranolaRun({
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
    "granola",
    updateStateWithRun(state, {
      at: new Date().toISOString(),
      rawFiles,
      runId,
      status,
      warnings,
    }),
  );

  return {
    connectorId: "granola",
    message,
    rawFiles,
    runId,
    statePath: `${openWikiConnectorsDisplayPath}/granola/state.json`,
    status,
    warnings,
  };
}

/**
 * Scans the Granola app-support directory for JSON caches that look like
 * document stores. The cache filename has changed across app versions and is
 * undocumented, so discovery is structural rather than name-based: any JSON
 * file whose parsed body contains a documents/meetings array qualifies.
 */
async function discoverCacheFile(
  appDir: string,
  warnings: string[],
): Promise<string | null> {
  let entries: string[];
  try {
    entries = await readdir(appDir);
  } catch {
    warnings.push(`No Granola app directory found at ${appDir}.`);
    return null;
  }

  const candidates = entries.filter((entry) => entry.endsWith(".json")).sort();
  for (const candidate of candidates.reverse()) {
    const candidatePath = path.join(appDir, candidate);
    try {
      const info = await stat(candidatePath);
      if (!info.isFile() || info.size === 0) {
        continue;
      }
      const parsed: unknown = JSON.parse(await readFile(candidatePath, "utf8"));
      if (extractDocuments(parsed) !== null) {
        return candidatePath;
      }
    } catch {
      // Unreadable or non-JSON; try the next candidate.
    }
  }

  return null;
}

/**
 * Extracts the document array from a Granola cache. Known shapes include a
 * top-level `documents` array and Supabase-style dumps where tables live
 * under nested keys, so walk one level deep looking for a plausible array.
 */
function extractDocuments(parsed: unknown): Record<string, unknown>[] | null {
  if (Array.isArray(parsed)) {
    return parsed.every((entry) => isPlausibleMeeting(entry))
      ? (parsed as Record<string, unknown>[])
      : null;
  }
  if (!isRecord(parsed)) {
    return null;
  }

  for (const key of ["documents", "meetings"]) {
    const value = parsed[key];
    if (
      Array.isArray(value) &&
      value.length > 0 &&
      value.every((entry) => isPlausibleMeeting(entry))
    ) {
      return value as Record<string, unknown>[];
    }
  }

  // One level of nesting covers `{ data: { documents: [...] } }`-style dumps.
  for (const nested of Object.values(parsed)) {
    if (!isRecord(nested)) {
      continue;
    }
    for (const key of ["documents", "meetings"]) {
      const value = nested[key];
      if (
        Array.isArray(value) &&
        value.length > 0 &&
        value.every((entry) => isPlausibleMeeting(entry))
      ) {
        return value as Record<string, unknown>[];
      }
    }
  }

  return null;
}

function isPlausibleMeeting(value: unknown): boolean {
  return isRecord(value) && (typeof value.id === "string" || isRecord(value.notes));
}

function parseDocumentCache(
  json: string,
  config: GranolaConfig,
  warnings: string[],
): GranolaMeeting[] {
  const documents = extractDocuments(JSON.parse(json));
  if (documents === null) {
    warnings.push("The Granola cache did not contain a recognizable documents list.");
    return [];
  }

  const meetings: GranolaMeeting[] = [];
  for (const document of documents) {
    const meeting = toMeeting(document, config);
    if (meeting !== null) {
      meetings.push(meeting);
    }
  }

  return meetings.sort(compareByRecency);
}

function toMeeting(
  document: Record<string, unknown>,
  config: GranolaConfig,
): GranolaMeeting | null {
  const notes = isRecord(document.notes) ? document.notes : {};
  const content = firstString(notes, [
    "notes_plain",
    "notes_markdown",
    "markdown",
    "content_markdown",
  ]);
  const title = firstString(document, ["title"]) ?? firstString(notes, ["title"]);
  const updatedAt =
    firstString(document, ["updated_at", "updatedAt"]) ??
    firstString(notes, ["updated_at"]);
  const createdAt =
    firstString(document, ["created_at", "createdAt"]) ??
    firstString(notes, ["created_at"]);

  if ((title ?? content) === undefined) {
    return null;
  }

  return {
    content,
    createdAt,
    id: firstString(document, ["id"]),
    title,
    updatedAt,
    ...(config.includeTranscript === true
      ? { transcriptExcerpt: extractTranscriptExcerpt(document) }
      : {}),
  };
}

/**
 * Transcript chunks can carry full meeting audio text; keep only a bounded
 * excerpt so one long meeting cannot dominate the dump.
 */
function extractTranscriptExcerpt(document: Record<string, unknown>): string | undefined {
  const chunks = document.transcript_chunks;
  if (!Array.isArray(chunks)) {
    return undefined;
  }

  const text = chunks
    .map((chunk) =>
      isRecord(chunk)
        ? (typeof chunk.text === "string" ? chunk.text : undefined)
        : (typeof chunk === "string" ? chunk : undefined),
    )
    .filter((text): text is string => text !== undefined)
    .join(" ")
    .replace(/\s+/gu, " ")
    .trim();

  return text.length > 0 ? (text.length > 1_000 ? `${text.slice(0, 1_000)}…` : text) : undefined;
}

function selectRecentMeetings(
  meetings: GranolaMeeting[],
  selection: { limit: number; windowHours: number | null },
): GranolaMeeting[] {
  if (selection.windowHours === null) {
    return meetings.slice(0, selection.limit);
  }

  const earliestMs = Date.now() - selection.windowHours * 60 * 60 * 1000;

  return meetings
    .filter((meeting) => {
      const timestampMs = Date.parse(meeting.updatedAt ?? meeting.createdAt ?? "");

      return Number.isNaN(timestampMs) || timestampMs >= earliestMs;
    })
    .slice(0, selection.limit);
}

/** Newest first so a truncated dump always carries the freshest meetings. */
function compareByRecency(a: GranolaMeeting, b: GranolaMeeting): number {
  const recency = (meeting: GranolaMeeting): number =>
    Date.parse(meeting.updatedAt ?? meeting.createdAt ?? "") || 0;

  return recency(b) - recency(a);
}

function firstString(
  record: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }

  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveTilde(value: string): string {
  if (value === "~") {
    return homedir();
  }
  if (value.startsWith("~/")) {
    return path.join(homedir(), value.slice(2));
  }

  return value;
}

function normalizeLimit(
  optionLimit: number | undefined,
  configLimit: number | undefined,
): number {
  const limit = optionLimit ?? configLimit ?? 30;

  return Math.max(1, Math.min(200, Math.trunc(limit)));
}

function normalizeWindowHours(windowHours: number | undefined): number | null {
  if (typeof windowHours !== "number" || !Number.isFinite(windowHours)) {
    return null;
  }

  return Math.max(1, Math.min(720, Math.trunc(windowHours)));
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
