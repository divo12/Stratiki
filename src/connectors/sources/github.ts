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

type GitHubConfig = {
  apiBaseUrl?: string;
  enabled?: boolean;
  includeCommits?: boolean;
  includeIssues?: boolean;
  includePullRequests?: boolean;
  maxPerRepo?: number;
  repos?: unknown;
};

type GitHubCommit = {
  authorLogin?: string;
  message?: string;
  sha?: string;
  url?: string;
};

type GitHubIssue = {
  isPullRequest: boolean;
  labels: string[];
  number?: number;
  state?: string;
  title?: string;
  updatedAt?: string;
  url?: string;
};

type RawGitHubCommit = {
  html_url?: string;
  sha?: string;
  commit?: { message?: string };
  author?: { login?: string };
};

type RawGitHubIssue = {
  html_url?: string;
  number?: number;
  state?: string;
  title?: string;
  updated_at?: string;
  labels?: { name?: string }[];
  pull_request?: unknown;
};

const DEFAULT_API_BASE_URL = "https://api.github.com";
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;

const definition: ConnectorDefinition = {
  backend: "direct-api",
  description:
    "Fetches recent commit, issue, and pull-request activity for configured GitHub repositories through the GitHub REST API.",
  displayName: "GitHub",
  id: "github",
  mode: "personal",
  // A token is strongly recommended (private repos, higher rate limits) but
  // public-repo ingestion works unauthenticated, so nothing is hard-required.
  requiredEnv: [],
  supportsAgenticDiscovery: false,
};

export function createGithubConnector(): ConnectorRuntime {
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
    ...(await readConnectorConfig<GitHubConfig>("github", {
      apiBaseUrl: DEFAULT_API_BASE_URL,
      enabled: true,
      includeCommits: true,
      includeIssues: true,
      includePullRequests: true,
      maxPerRepo: 30,
      repos: [],
    })),
    ...((options.connectorConfig ?? {}) as GitHubConfig),
  };
  const state = await readConnectorState("github");
  const warnings: string[] = [];
  const rawFiles: string[] = [];

  if (!config.enabled) {
    return {
      connectorId: "github",
      message: `GitHub connector is not enabled. Set enabled=true in ${openWikiConnectorsDisplayPath}/github/config.json.`,
      rawFiles,
      runId,
      statePath: `${openWikiConnectorsDisplayPath}/github/state.json`,
      status: "skipped",
      warnings,
    };
  }

  const { invalidRepos, repos } = normalizeRepoList(config.repos);
  if (invalidRepos.length > 0) {
    warnings.push(
      `Ignored invalid GitHub repo(s): ${invalidRepos.join(", ")}. Use owner/name format.`,
    );
  }
  if (repos.length === 0) {
    return await finishGithubRun({
      message:
        "No valid GitHub repositories are configured. Add at least one owner/name repo to the github connector config.",
      rawFiles,
      runId,
      state,
      status: "error",
      warnings,
    });
  }

  const token = resolveGitHubToken();
  if (token === null) {
    warnings.push(
      "No GITHUB_TOKEN or GH_TOKEN found; unauthenticated GitHub API requests are limited to 60/hour and cannot see private repositories.",
    );
  }

  const limit = normalizeLimit(options.limit, config.maxPerRepo);
  const windowHours = normalizeWindowHours(options.windowHours);
  const sinceIso =
    windowHours === null
      ? null
      : new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString();

  const repoResults = [];
  for (const repo of repos) {
    try {
      repoResults.push({
        activity: await fetchRepoActivity(repo, config, {
          limit,
          sinceIso,
          token,
        }),
        repo,
      });
    } catch (error) {
      warnings.push(`${repo}: ${getErrorMessage(error)}`);
    }
  }

  rawFiles.push(
    await writeRawJson("github", runId, "github-results.json", {
      fetchedAt: new Date().toISOString(),
      instanceId: options.instanceId,
      repos: repoResults,
      since: sinceIso,
      windowHours,
    }),
  );

  return await finishGithubRun({
    message: `Fetched GitHub activity for ${repoResults.length} repo${
      repoResults.length === 1 ? "" : "s"
    }.`,
    rawFiles,
    runId,
    state,
    status: "success",
    warnings,
  });
}

async function finishGithubRun({
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
    "github",
    updateStateWithRun(state, {
      at: new Date().toISOString(),
      rawFiles,
      runId,
      status,
      warnings,
    }),
  );

  return {
    connectorId: "github",
    message,
    rawFiles,
    runId,
    statePath: `${openWikiConnectorsDisplayPath}/github/state.json`,
    status,
    warnings,
  };
}

async function fetchRepoActivity(
  repo: string,
  config: GitHubConfig,
  fetchOptions: {
    limit: number;
    sinceIso: string | null;
    token: string | null;
  },
): Promise<{
  commits: GitHubCommit[];
  issues: GitHubIssue[];
  pullRequests: GitHubIssue[];
}> {
  const baseUrl = (config.apiBaseUrl ?? DEFAULT_API_BASE_URL).replace(
    /\/+$/u,
    "",
  );
  const [commits, issues] = await Promise.all([
    config.includeCommits === false
      ? Promise.resolve([])
      : fetchCommits(baseUrl, repo, fetchOptions),
    config.includeIssues === false && config.includePullRequests === false
      ? Promise.resolve([])
      : fetchIssues(baseUrl, repo, fetchOptions),
  ]);

  return splitIssuesFromPulls(commits, issues, config);
}

async function fetchCommits(
  baseUrl: string,
  repo: string,
  {
    limit,
    sinceIso,
    token,
  }: { limit: number; sinceIso: string | null; token: string | null },
): Promise<RawGitHubCommit[]> {
  const url = new URL(`/repos/${repo}/commits`, baseUrl);
  url.searchParams.set("per_page", String(limit));
  if (sinceIso !== null) {
    url.searchParams.set("since", sinceIso);
  }

  return (await githubApi<RawGitHubCommit[]>(url, token)) ?? [];
}

async function fetchIssues(
  baseUrl: string,
  repo: string,
  {
    limit,
    sinceIso,
    token,
  }: { limit: number; sinceIso: string | null; token: string | null },
): Promise<RawGitHubIssue[]> {
  // The REST issues listing includes pull requests; they carry a
  // `pull_request` key and are split apart by splitIssuesFromPulls.
  const url = new URL(`/repos/${repo}/issues`, baseUrl);
  url.searchParams.set("direction", "desc");
  url.searchParams.set("per_page", String(limit));
  url.searchParams.set("sort", "updated");
  url.searchParams.set("state", "all");
  if (sinceIso !== null) {
    url.searchParams.set("since", sinceIso);
  }

  return (await githubApi<RawGitHubIssue[]>(url, token)) ?? [];
}

function splitIssuesFromPulls(
  commits: RawGitHubCommit[],
  issues: RawGitHubIssue[],
  config: GitHubConfig,
): {
  commits: GitHubCommit[];
  issues: GitHubIssue[];
  pullRequests: GitHubIssue[];
} {
  const mapped = issues.map((issue) => ({
    isPullRequest: issue.pull_request !== undefined,
    labels: (issue.labels ?? [])
      .map((label) => label.name)
      .filter((name): name is string => typeof name === "string"),
    number: issue.number,
    state: issue.state,
    title: issue.title,
    updatedAt: issue.updated_at,
    url: issue.html_url,
  }));

  return {
    commits: commits.map((commit) => ({
      authorLogin: commit.author?.login,
      message: commit.commit?.message?.split("\n")[0],
      sha: commit.sha?.slice(0, 12),
      url: commit.html_url,
    })),
    issues:
      config.includeIssues === false
        ? []
        : mapped.filter((item) => !item.isPullRequest),
    pullRequests:
      config.includePullRequests === false
        ? []
        : mapped.filter((item) => item.isPullRequest),
  };
}

/**
 * Calls the GitHub REST API with an optional bearer token. Returns `null` for
 * a 204 (empty result set) so callers can coalesce to empty lists.
 */
async function githubApi<T>(url: URL, token: string | null): Promise<T | null> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token !== null) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetchWithResilience(url, { headers });

  if (!response.ok) {
    throw new Error(
      `GitHub API request failed: ${response.status} ${response.statusText}`,
    );
  }
  if (response.status === 204) {
    return null;
  }

  return (await response.json()) as T;
}

/** Resolves the connector's optional credential without gating the run. */
export function resolveGitHubToken(): string | null {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;

  return typeof token === "string" && token.trim().length > 0
    ? token.trim()
    : null;
}

function normalizeRepoList(configRepos: unknown): {
  invalidRepos: string[];
  repos: string[];
} {
  const values = normalizeStringArray(configRepos);
  const repos: string[] = [];
  const invalidRepos: string[] = [];

  for (const value of values) {
    if (REPO_PATTERN.test(value)) {
      repos.push(value);
    } else {
      invalidRepos.push(value);
    }
  }

  return { invalidRepos, repos };
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
