import {
  createRunId,
  readConnectorConfig,
  readConnectorState,
  updateStateWithRun,
  writeConnectorState,
  writeRawJson,
} from "../io.js";
import { fetchWithResilience } from "../http.js";
import { normalizeStringArray } from "../config.js";
import { openWikiConnectorsDisplayPath } from "../../config/openwiki-home.js";
import type {
  ConnectorDefinition,
  ConnectorIngestOptions,
  ConnectorIngestResult,
  ConnectorRuntime,
} from "../types.js";

type RedditConfig = {
  enabled?: boolean;
  includeStickied?: boolean;
  maxItemsPerSource?: number;
  queries?: unknown;
  sort?: string;
  subreddits?: unknown;
};

type RedditPost = {
  author?: string;
  commentCount?: number;
  createdAt?: string;
  permalink?: string;
  score?: number;
  selftext?: string;
  subreddit?: string;
  title?: string;
  url?: string;
};

type RedditListing = {
  data?: {
    children?: {
      data?: {
        author?: string;
        created_utc?: number;
        num_comments?: number;
        over_18?: boolean;
        permalink?: string;
        score?: number;
        selftext?: string;
        stickied?: boolean;
        subreddit?: string;
        title?: string;
        url?: string;
      };
    }[];
  };
};

const REDDIT_BASE_URL = "https://www.reddit.com";
const VALID_SORTS = ["hot", "new", "top"] as const;
// Reddit rejects requests with default library user agents; a descriptive UA
// per their API guidance is required for public JSON endpoints.
const USER_AGENT = "stratiki-connector/0.1 (personal knowledge wiki)";

const definition: ConnectorDefinition = {
  backend: "direct-api",
  description:
    "Fetches new posts and search results from configured public subreddits through Reddit's public JSON API.",
  displayName: "Reddit",
  id: "reddit",
  mode: "personal",
  requiredEnv: [],
  supportsAgenticDiscovery: false,
};

export function createRedditConnector(): ConnectorRuntime {
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
    ...(await readConnectorConfig<RedditConfig>("reddit", {
      enabled: true,
      includeStickied: false,
      maxItemsPerSource: 25,
      queries: [],
      sort: "new",
      subreddits: [],
    })),
    ...((options.connectorConfig ?? {}) as RedditConfig),
  };
  const state = await readConnectorState("reddit");
  const warnings: string[] = [];
  const rawFiles: string[] = [];

  if (!config.enabled) {
    return {
      connectorId: "reddit",
      message: `Reddit connector is not enabled. Set enabled=true in ${openWikiConnectorsDisplayPath}/reddit/config.json.`,
      rawFiles,
      runId,
      statePath: `${openWikiConnectorsDisplayPath}/reddit/state.json`,
      status: "skipped",
      warnings,
    };
  }

  const subreddits = normalizeStringArray(config.subreddits);
  const queries = normalizeStringArray(config.queries);
  if (subreddits.length === 0 && queries.length === 0) {
    return await finishRedditRun({
      message:
        "No Reddit subreddits or search queries are configured. Add at least one subreddit or query to the reddit connector config.",
      rawFiles,
      runId,
      state,
      status: "error",
      warnings,
    });
  }

  const limit = normalizeLimit(options.limit, config.maxItemsPerSource);
  const windowHours = normalizeWindowHours(options.windowHours);
  const earliestUnixTime =
    windowHours === null
      ? null
      : Math.floor((Date.now() - windowHours * 60 * 60 * 1000) / 1000);
  const sort = resolveSort(config.sort, warnings);

  const feedResults = [];
  for (const subreddit of subreddits) {
    try {
      const listing = await fetchJson(
        `${REDDIT_BASE_URL}/r/${encodeURIComponent(subreddit)}/${sort}.json`,
        { limit },
      );
      feedResults.push({
        items: selectPosts(listing, config, { earliestUnixTime, limit }),
        subreddit,
      });
    } catch (error) {
      warnings.push(`r/${subreddit}: ${getErrorMessage(error)}`);
    }
  }

  const queryResults = [];
  for (const query of queries) {
    try {
      const listing = await fetchJson(`${REDDIT_BASE_URL}/search.json`, {
        limit,
        q: query,
        sort: "new",
      });
      queryResults.push({
        items: selectPosts(listing, config, { earliestUnixTime, limit }),
        query,
      });
    } catch (error) {
      warnings.push(`${query}: ${getErrorMessage(error)}`);
    }
  }

  rawFiles.push(
    await writeRawJson("reddit", runId, "reddit-results.json", {
      fetchedAt: new Date().toISOString(),
      feeds: feedResults,
      instanceId: options.instanceId,
      queryResults,
      sort,
      windowHours,
    }),
  );

  return await finishRedditRun({
    message: `Fetched ${feedResults.length} subreddit(s) and ${queryResults.length} search quer${
      queryResults.length === 1 ? "y" : "ies"
    }.`,
    rawFiles,
    runId,
    state,
    status: "success",
    warnings,
  });
}

async function finishRedditRun({
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
    "reddit",
    updateStateWithRun(state, {
      at: new Date().toISOString(),
      rawFiles,
      runId,
      status,
      warnings,
    }),
  );

  return {
    connectorId: "reddit",
    message,
    rawFiles,
    runId,
    statePath: `${openWikiConnectorsDisplayPath}/reddit/state.json`,
    status,
    warnings,
  };
}

async function fetchJson(
  url: string,
  params: Record<string, number | string>,
): Promise<RedditListing> {
  const requestUrl = new URL(url);
  requestUrl.searchParams.set("raw_json", "1");
  for (const [key, value] of Object.entries(params)) {
    requestUrl.searchParams.set(key, String(value));
  }

  const response = await fetchWithResilience(requestUrl, {
    headers: { Accept: "application/json", "User-Agent": USER_AGENT },
  });

  if (!response.ok) {
    throw new Error(
      `Reddit request failed: ${response.status} ${response.statusText}`,
    );
  }

  return (await response.json()) as RedditListing;
}

function selectPosts(
  listing: RedditListing,
  config: RedditConfig,
  selectOptions: { earliestUnixTime: number | null; limit: number },
): RedditPost[] {
  const posts: RedditPost[] = [];
  for (const child of listing.data?.children ?? []) {
    const post = child.data;
    if (post === undefined) {
      continue;
    }
    if (
      config.includeStickied !== true &&
      post.stickied === true &&
      post.subreddit !== undefined
    ) {
      continue;
    }
    if (
      selectOptions.earliestUnixTime !== null &&
      (post.created_utc ?? 0) < selectOptions.earliestUnixTime
    ) {
      continue;
    }
    posts.push({
      author: post.author,
      commentCount: post.num_comments,
      createdAt:
        typeof post.created_utc === "number"
          ? new Date(post.created_utc * 1000).toISOString()
          : undefined,
      permalink:
        typeof post.permalink === "string"
          ? `https://www.reddit.com${post.permalink}`
          : undefined,
      score: post.score,
      selftext: post.selftext || undefined,
      subreddit: post.subreddit,
      title: post.title,
      url:
        post.url && !post.url.startsWith("https://www.reddit.com")
          ? post.url
          : undefined,
    });
  }

  return posts.slice(0, selectOptions.limit);
}

function resolveSort(
  configSort: string | undefined,
  warnings: string[],
): string {
  const sort = (configSort ?? "new").toLowerCase();

  if ((VALID_SORTS as readonly string[]).includes(sort)) {
    return sort;
  }

  warnings.push(
    `Ignored invalid Reddit sort "${configSort}". Valid sorts are: ${VALID_SORTS.join(", ")}. Using "new".`,
  );

  return "new";
}

function normalizeLimit(
  optionLimit: number | undefined,
  configLimit: number | undefined,
): number {
  const limit = optionLimit ?? configLimit ?? 25;

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
