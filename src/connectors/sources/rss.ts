import { stripHtmlTags } from "../../platform/utils.js";
import { fetchWithResilience } from "../http.js";
import {
  createRunId,
  readConnectorConfig,
  readConnectorState,
  updateStateWithRun,
  writeConnectorState,
  writeRawJson,
} from "../io.js";
import { normalizeStringArray } from "../config.js";
import { openWikiConnectorsDisplayPath } from "../../config/openwiki-home.js";
import type {
  ConnectorDefinition,
  ConnectorIngestOptions,
  ConnectorIngestResult,
  ConnectorRuntime,
} from "../types.js";

type RssConfig = {
  enabled?: boolean;
  feeds?: unknown;
  maxItemsPerFeed?: number;
};

type FeedKind = "atom" | "rss";

type FeedItem = {
  link?: string;
  publishedAt?: string;
  summary?: string;
  title?: string;
};

type ParsedFeed = {
  items: FeedItem[];
  kind: FeedKind;
  title?: string;
};

const definition: ConnectorDefinition = {
  backend: "direct-api",
  description:
    "Fetches configured RSS and Atom feeds such as company blogs, changelogs, status pages, and competitor news.",
  displayName: "RSS / Atom",
  id: "rss",
  mode: "personal",
  requiredEnv: [],
  supportsAgenticDiscovery: false,
};

export function createRssConnector(): ConnectorRuntime {
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
    ...(await readConnectorConfig<RssConfig>("rss", {
      enabled: true,
      feeds: [],
      maxItemsPerFeed: 30,
    })),
    ...((options.connectorConfig ?? {}) as RssConfig),
  };
  const state = await readConnectorState("rss");
  const warnings: string[] = [];
  const rawFiles: string[] = [];

  if (!config.enabled) {
    return {
      connectorId: "rss",
      message: `RSS connector is not enabled. Set enabled=true in ${openWikiConnectorsDisplayPath}/rss/config.json.`,
      rawFiles,
      runId,
      statePath: `${openWikiConnectorsDisplayPath}/rss/state.json`,
      status: "skipped",
      warnings,
    };
  }

  const { feeds, invalidFeeds } = normalizeFeedUrls(config.feeds);
  if (invalidFeeds.length > 0) {
    warnings.push(
      `Ignored invalid RSS feed URL(s): ${invalidFeeds.join(", ")}. Feeds must be http(s) URLs.`,
    );
  }
  if (feeds.length === 0) {
    return await finishRssRun({
      message:
        "No valid RSS or Atom feed URLs are configured. Add at least one http(s) feed URL to the rss connector config.",
      rawFiles,
      runId,
      state,
      status: "error",
      warnings,
    });
  }

  const limit = normalizeLimit(options.limit, config.maxItemsPerFeed);
  const windowHours = normalizeWindowHours(options.windowHours);

  const feedResults = [];
  for (const url of feeds) {
    try {
      const xml = await fetchFeed(url);
      const parsed = parseFeed(xml);
      feedResults.push({
        items: selectRecentItems(parsed.items, limit, windowHours),
        kind: parsed.kind,
        title: parsed.title,
        url,
      });
    } catch (error) {
      warnings.push(`${url}: ${getErrorMessage(error)}`);
    }
  }

  rawFiles.push(
    await writeRawJson("rss", runId, "rss-results.json", {
      fetchedAt: new Date().toISOString(),
      feeds: feedResults,
      instanceId: options.instanceId,
      windowHours,
    }),
  );

  const itemCount = feedResults.reduce(
    (total, feed) => total + feed.items.length,
    0,
  );

  return await finishRssRun({
    message: `Fetched ${feedResults.length} feed(s) and ${itemCount} item${
      itemCount === 1 ? "" : "s"
    }.`,
    rawFiles,
    runId,
    state,
    status: "success",
    warnings,
  });
}

async function finishRssRun({
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
    "rss",
    updateStateWithRun(state, {
      at: new Date().toISOString(),
      rawFiles,
      runId,
      status,
      warnings,
    }),
  );

  return {
    connectorId: "rss",
    message,
    rawFiles,
    runId,
    statePath: `${openWikiConnectorsDisplayPath}/rss/state.json`,
    status,
    warnings,
  };
}

async function fetchFeed(url: string): Promise<string> {
  const response = await fetchWithResilience(url, {
    headers: { Accept: "application/rss+xml, application/atom+xml, */*" },
  });

  if (!response.ok) {
    throw new Error(
      `feed request failed: ${response.status} ${response.statusText}`,
    );
  }

  return await response.text();
}

/**
 * Minimal dependency-free RSS 2.0 / Atom parser. Extracts the fields the wiki
 * needs (title, link, timestamp, plain-text summary) from well-formed feeds.
 * Namespace prefixes are ignored so `<atom:updated>` matches `<updated>`.
 */
export function parseFeed(xml: string): ParsedFeed {
  const isAtom = /<feed[\s>]/iu.test(xml);

  if (isAtom) {
    return {
      items: matchElements(xml, "entry").map(parseAtomEntry),
      kind: "atom",
      title: decodeXmlText(extractTagContent(xml, "title")),
    };
  }

  return {
    items: matchElements(xml, "item").map(parseRssItem),
    kind: "rss",
    title: decodeXmlText(extractTagContent(extractChannelScope(xml), "title")),
  };
}

function parseRssItem(itemXml: string): FeedItem {
  const publishedRaw =
    extractTagContent(itemXml, "pubDate") ?? extractTagContent(itemXml, "date");

  return {
    link: decodeXmlText(
      extractTagContent(itemXml, "link") ??
        extractTagAttribute(itemXml, "link", "href"),
    ),
    publishedAt: toIsoTimestamp(publishedRaw),
    summary: toPlainText(
      extractTagContent(itemXml, "description") ??
        extractTagContent(itemXml, "content:encoded"),
    ),
    title: decodeXmlText(extractTagContent(itemXml, "title")),
  };
}

function parseAtomEntry(entryXml: string): FeedItem {
  const publishedRaw =
    extractTagContent(entryXml, "published") ??
    extractTagContent(entryXml, "updated");

  return {
    link: decodeXmlText(extractTagAttribute(entryXml, "link", "href")),
    publishedAt: toIsoTimestamp(publishedRaw),
    summary: toPlainText(
      extractTagContent(entryXml, "summary") ??
        extractTagContent(entryXml, "content"),
    ),
    title: decodeXmlText(extractTagContent(entryXml, "title")),
  };
}

function matchElements(xml: string, tagName: string): string[] {
  const elementPattern = new RegExp(
    `<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)</${tagName}>`,
    "giu",
  );
  const elements: string[] = [];

  for (const match of xml.matchAll(elementPattern)) {
    elements.push(match[1] ?? "");
  }

  return elements;
}

function extractChannelScope(xml: string): string {
  return matchElements(xml, "channel")[0] ?? xml;
}

function extractTagContent(scope: string, tagName: string): string | null {
  // The tag name may carry a namespace prefix (`content:encoded`), which the
  // regex expresses as an optional prefix group around the local name.
  const [prefix, localName] = tagName.includes(":")
    ? [tagName.split(":")[0], tagName.split(":").slice(1).join(":")]
    : [null, tagName];
  const prefixPattern =
    prefix === null ? "(?:[A-Za-z][A-Za-z0-9_-]*:)?" : `${prefix}:`;
  const pattern = new RegExp(
    `<${prefixPattern}${localName}(?:\\s[^>]*)?>([\\s\\S]*?)</${prefixPattern}${localName}>`,
    "iu",
  );

  return scope.match(pattern)?.[1] ?? null;
}

function extractTagAttribute(
  scope: string,
  tagName: string,
  attributeName: string,
): string | null {
  const pattern = new RegExp(
    `<${tagName}\\b[^>]*\\s${attributeName}="([^"]*)"`,
    "iu",
  );

  return scope.match(pattern)?.[1] ?? null;
}

function decodeXmlText(value: string | null): string | undefined {
  if (value === null) {
    return undefined;
  }

  const withoutCdata = value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gu, "$1");

  return decodeEntities(withoutCdata.trim()) || undefined;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/giu, (_, hex: string) =>
      safeFromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/gu, (_, dec: string) =>
      safeFromCodePoint(Number.parseInt(dec, 10)),
    )
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&amp;/gu, "&");
}

function safeFromCodePoint(codePoint: number): string {
  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return "";
  }
}

/** Collapse embedded HTML into readable plain text for the raw dump. */
function toPlainText(value: string | null): string | undefined {
  if (value === null) {
    return undefined;
  }

  const text = stripHtmlTags(decodeEntities(value))
    .replace(/\s+/gu, " ")
    .trim();

  return text || undefined;
}

function toIsoTimestamp(value: string | null): string | undefined {
  if (value === null) {
    return undefined;
  }

  const parsedMs = Date.parse(value.trim());

  return Number.isNaN(parsedMs) ? undefined : new Date(parsedMs).toISOString();
}

function selectRecentItems(
  items: FeedItem[],
  limit: number,
  windowHours: number | null,
): FeedItem[] {
  const earliestMs =
    windowHours === null ? null : Date.now() - windowHours * 60 * 60 * 1000;

  return items
    .filter((item) => {
      if (earliestMs === null || item.publishedAt === undefined) {
        return true;
      }

      return (Date.parse(item.publishedAt) || 0) >= earliestMs;
    })
    .slice(0, limit);
}

function normalizeFeedUrls(configFeeds: RssConfig["feeds"]): {
  feeds: string[];
  invalidFeeds: string[];
} {
  const values = normalizeStringArray(configFeeds);
  const feeds: string[] = [];
  const invalidFeeds: string[] = [];

  for (const value of values) {
    if (/^https:\/\/\S+$/iu.test(value) || /^http:\/\/\S+$/iu.test(value)) {
      feeds.push(value);
    } else {
      invalidFeeds.push(value);
    }
  }

  return { feeds, invalidFeeds };
}

function normalizeLimit(
  optionLimit: number | undefined,
  configLimit: number | undefined,
): number {
  const limit = optionLimit ?? configLimit ?? 30;

  return Math.max(1, Math.min(100, Math.trunc(limit)));
}

function normalizeWindowHours(windowHours: number | undefined): number | null {
  if (typeof windowHours !== "number" || !Number.isFinite(windowHours)) {
    return null;
  }

  return Math.max(1, Math.min(168, Math.trunc(windowHours)));
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
