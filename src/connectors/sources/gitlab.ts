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

type GitLabConfig = {
  baseUrl?: string;
  enabled?: boolean;
  includeCommits?: boolean;
  includeIssues?: boolean;
  includeMergeRequests?: boolean;
  maxPerProject?: number;
  projects?: unknown;
};

type GitLabCommit = {
  authorName?: string;
  message?: string;
  sha?: string;
  url?: string;
};

type GitLabRecord = {
  iid?: number;
  labels: string[];
  state?: string;
  title?: string;
  updatedAt?: string;
  url?: string;
  webUrl?: string;
};

type RawGitLabCommit = {
  author_name?: string;
  id?: string;
  message?: string;
  web_url?: string;
};

type RawGitLabRecord = {
  iid?: number;
  labels?: (string | { name?: string })[];
  state?: string;
  title?: string;
  updated_at?: string;
  web_url?: string;
};

const DEFAULT_BASE_URL = "https://gitlab.com";
const PROJECT_PATTERN = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/u;

const definition: ConnectorDefinition = {
  backend: "direct-api",
  description:
    "Fetches recent commit, merge-request, and issue activity for configured GitLab projects through the GitLab REST API.",
  displayName: "GitLab",
  id: "gitlab",
  mode: "personal",
  // A token is strongly recommended (private projects, higher rate limits)
  // but public-project ingestion works unauthenticated.
  requiredEnv: [],
  supportsAgenticDiscovery: false,
};

export function createGitLabConnector(): ConnectorRuntime {
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
    ...(await readConnectorConfig<GitLabConfig>("gitlab", {
      baseUrl: DEFAULT_BASE_URL,
      enabled: true,
      includeCommits: true,
      includeIssues: true,
      includeMergeRequests: true,
      maxPerProject: 30,
      projects: [],
    })),
    ...((options.connectorConfig ?? {}) as GitLabConfig),
  };
  const state = await readConnectorState("gitlab");
  const warnings: string[] = [];
  const rawFiles: string[] = [];

  if (!config.enabled) {
    return {
      connectorId: "gitlab",
      message: `GitLab connector is not enabled. Set enabled=true in ${openWikiConnectorsDisplayPath}/gitlab/config.json.`,
      rawFiles,
      runId,
      statePath: `${openWikiConnectorsDisplayPath}/gitlab/state.json`,
      status: "skipped",
      warnings,
    };
  }

  const { invalidProjects, projects } = normalizeProjectList(config.projects);
  if (invalidProjects.length > 0) {
    warnings.push(
      `Ignored invalid GitLab project(s): ${invalidProjects.join(", ")}. Use group/project format.`,
    );
  }
  if (projects.length === 0) {
    return await finishGitLabRun({
      message:
        "No valid GitLab projects are configured. Add at least one group/project to the gitlab connector config.",
      rawFiles,
      runId,
      state,
      status: "error",
      warnings,
    });
  }

  const token = resolveGitLabToken();
  if (token === null) {
    warnings.push(
      "No GITLAB_TOKEN found; unauthenticated GitLab API requests are heavily rate-limited and cannot see private projects.",
    );
  }

  const limit = normalizeLimit(options.limit, config.maxPerProject);
  const windowHours = normalizeWindowHours(options.windowHours);
  const sinceIso =
    windowHours === null
      ? null
      : new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString();

  const baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/u, "");
  const projectResults = [];
  for (const project of projects) {
    try {
      projectResults.push({
        activity: await fetchProjectActivity(baseUrl, project, config, {
          limit,
          sinceIso,
          token,
        }),
        project,
      });
    } catch (error) {
      warnings.push(`${project}: ${getErrorMessage(error)}`);
    }
  }

  rawFiles.push(
    await writeRawJson("gitlab", runId, "gitlab-results.json", {
      baseUrl,
      fetchedAt: new Date().toISOString(),
      instanceId: options.instanceId,
      projects: projectResults,
      since: sinceIso,
      windowHours,
    }),
  );

  return await finishGitLabRun({
    message: `Fetched GitLab activity for ${projectResults.length} project${
      projectResults.length === 1 ? "" : "s"
    }.`,
    rawFiles,
    runId,
    state,
    status: "success",
    warnings,
  });
}

async function finishGitLabRun({
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
    "gitlab",
    updateStateWithRun(state, {
      at: new Date().toISOString(),
      rawFiles,
      runId,
      status,
      warnings,
    }),
  );

  return {
    connectorId: "gitlab",
    message,
    rawFiles,
    runId,
    statePath: `${openWikiConnectorsDisplayPath}/gitlab/state.json`,
    status,
    warnings,
  };
}

async function fetchProjectActivity(
  baseUrl: string,
  project: string,
  config: GitLabConfig,
  fetchOptions: {
    limit: number;
    sinceIso: string | null;
    token: string | null;
  },
): Promise<{
  commits: GitLabCommit[];
  issues: GitLabRecord[];
  mergeRequests: GitLabRecord[];
}> {
  const [commits, mergeRequests, issues] = await Promise.all([
    config.includeCommits === false
      ? Promise.resolve([])
      : fetchCommits(baseUrl, project, fetchOptions),
    config.includeMergeRequests === false
      ? Promise.resolve([])
      : fetchRecords(baseUrl, project, "merge_requests", fetchOptions),
    config.includeIssues === false
      ? Promise.resolve([])
      : fetchRecords(baseUrl, project, "issues", fetchOptions),
  ]);

  return {
    commits: commits.map((commit) => ({
      authorName: commit.author_name,
      message: commit.message?.split("\n")[0],
      sha: commit.id?.slice(0, 12),
      url: commit.web_url,
    })),
    issues: mapRecords(issues),
    mergeRequests: mapRecords(mergeRequests),
  };
}

async function fetchCommits(
  baseUrl: string,
  project: string,
  {
    limit,
    sinceIso,
    token,
  }: { limit: number; sinceIso: string | null; token: string | null },
): Promise<RawGitLabCommit[]> {
  const url = new URL(
    `/api/v4/projects/${encodeURIComponent(project)}/repository/commits`,
    baseUrl,
  );
  url.searchParams.set("all", "true");
  url.searchParams.set("per_page", String(limit));
  if (sinceIso !== null) {
    url.searchParams.set("since", sinceIso);
  }

  return (await gitlabApi<RawGitLabCommit[]>(url, token)) ?? [];
}

async function fetchRecords(
  baseUrl: string,
  project: string,
  recordType: "issues" | "merge_requests",
  {
    limit,
    sinceIso,
    token,
  }: { limit: number; sinceIso: string | null; token: string | null },
): Promise<RawGitLabRecord[]> {
  // The list APIs order by creation by default; we request newest-first by
  // update and apply the window client-side because the MR API lacks a
  // reliable `since` parameter across self-hosted versions.
  const url = new URL(
    `/api/v4/projects/${encodeURIComponent(project)}/${recordType}`,
    baseUrl,
  );
  url.searchParams.set("order_by", "updated_at");
  url.searchParams.set("per_page", String(limit));
  url.searchParams.set("sort", "desc");
  url.searchParams.set("state", "all");

  const records = (await gitlabApi<RawGitLabRecord[]>(url, token)) ?? [];

  if (sinceIso === null) {
    return records;
  }

  const sinceMs = Date.parse(sinceIso);

  return records.filter(
    (record) => (Date.parse(record.updated_at ?? "") || 0) >= sinceMs,
  );
}

function mapRecords(records: RawGitLabRecord[]): GitLabRecord[] {
  return records.map((record) => ({
    iid: record.iid,
    labels: (record.labels ?? [])
      .map((label) => (typeof label === "string" ? label : label.name))
      .filter((label): label is string => typeof label === "string"),
    state: record.state,
    title: record.title,
    updatedAt: record.updated_at,
    webUrl: record.web_url,
  }));
}

/** Calls the GitLab REST API with an optional PRIVATE-TOKEN. */
async function gitlabApi<T>(url: URL, token: string | null): Promise<T | null> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (token !== null) {
    headers["PRIVATE-TOKEN"] = token;
  }

  const response = await fetchWithResilience(url, { headers });

  if (!response.ok) {
    throw new Error(
      `GitLab API request failed: ${response.status} ${response.statusText}`,
    );
  }
  if (response.status === 204) {
    return null;
  }

  return (await response.json()) as T;
}

export function resolveGitLabToken(): string | null {
  const token = process.env.GITLAB_TOKEN ?? process.env.GL_TOKEN;

  return typeof token === "string" && token.trim().length > 0
    ? token.trim()
    : null;
}

function normalizeProjectList(configProjects: unknown): {
  invalidProjects: string[];
  projects: string[];
} {
  const values = normalizeStringArray(configProjects);
  const projects: string[] = [];
  const invalidProjects: string[] = [];

  for (const value of values) {
    if (PROJECT_PATTERN.test(value)) {
      projects.push(value);
    } else {
      invalidProjects.push(value);
    }
  }

  return { invalidProjects, projects };
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
