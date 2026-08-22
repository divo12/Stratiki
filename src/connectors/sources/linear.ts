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

type LinearConfig = {
  enabled?: boolean;
  includeDescription?: boolean;
  maxIssues?: number;
  projects?: unknown;
  teams?: unknown;
};

type LinearIssue = {
  assigneeName?: string;
  description?: string;
  identifier?: string;
  labels: string[];
  projectName?: string;
  stateName?: string;
  teamKey?: string;
  title?: string;
  updatedAt?: string;
  url?: string;
};

type GraphQLResponse<T> = {
  data?: T;
  errors?: { message: string }[];
};

type IssuesQueryResult = {
  issues?: {
    nodes?: {
      assignee?: { displayName?: string };
      description?: string;
      identifier?: string;
      labels?: { nodes?: { name?: string }[] };
      project?: { name?: string };
      state?: { name?: string };
      team?: { key?: string };
      title?: string;
      updatedAt?: string;
      url?: string;
    }[];
  };
};

const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";
const ISSUES_QUERY = `
query RecentIssues($first: Int!, $since: DateTime!, $teams: [String!]) {
  issues(
    first: $first
    orderBy: updatedAt
    filter: {
      updatedAt: { gte: $since }
      team: { key: { in: $teams } }
    }
  ) {
    nodes {
      id
      identifier
      title
      description
      url
      updatedAt
      state { name }
      assignee { displayName }
      project { name }
      team { key }
      labels { nodes { name } }
    }
  }
}
`.trim();

const definition: ConnectorDefinition = {
  backend: "direct-api",
  description:
    "Fetches recently updated Linear issues, with optional team filtering, through the Linear GraphQL API.",
  displayName: "Linear",
  id: "linear",
  mode: "personal",
  requiredEnv: ["LINEAR_API_KEY"],
  supportsAgenticDiscovery: false,
};

export function createLinearConnector(): ConnectorRuntime {
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
    ...(await readConnectorConfig<LinearConfig>("linear", {
      enabled: true,
      includeDescription: true,
      maxIssues: 50,
      projects: [],
      teams: [],
    })),
    ...((options.connectorConfig ?? {}) as LinearConfig),
  };
  const state = await readConnectorState("linear");
  const warnings: string[] = [];
  const rawFiles: string[] = [];

  if (!config.enabled) {
    return {
      connectorId: "linear",
      message: `Linear connector is not enabled. Set enabled=true in ${openWikiConnectorsDisplayPath}/linear/config.json.`,
      rawFiles,
      runId,
      statePath: `${openWikiConnectorsDisplayPath}/linear/state.json`,
      status: "skipped",
      warnings,
    };
  }

  const apiKey = process.env.LINEAR_API_KEY;
  if (typeof apiKey !== "string" || apiKey.trim().length === 0) {
    return await finishLinearRun({
      message:
        "LINEAR_API_KEY is not set. Create a Linear API key and add it to the Stratiki environment.",
      rawFiles,
      runId,
      state,
      status: "error",
      warnings,
    });
  }

  const limit = normalizeLimit(options.limit, config.maxIssues);
  const windowHours = normalizeWindowHours(options.windowHours) ?? 24;
  const sinceIso = new Date(
    Date.now() - windowHours * 60 * 60 * 1000,
  ).toISOString();
  const teams = normalizeStringArray(config.teams);

  let issues: LinearIssue[] = [];
  try {
    issues = await fetchIssues(apiKey.trim(), {
      includeDescription: config.includeDescription !== false,
      limit,
      sinceIso,
      teams,
    });
  } catch (error) {
    warnings.push(getErrorMessage(error));
  }

  const projectFilters = normalizeStringArray(config.projects);
  const filteredIssues =
    projectFilters.length > 0
      ? issues.filter(
          (issue) =>
            issue.projectName !== undefined &&
            projectFilters.includes(issue.projectName),
        )
      : issues;

  rawFiles.push(
    await writeRawJson("linear", runId, "linear-issues.json", {
      fetchedAt: new Date().toISOString(),
      instanceId: options.instanceId,
      issues: filteredIssues,
      projects: projectFilters,
      since: sinceIso,
      teams,
      windowHours,
    }),
  );

  return await finishLinearRun({
    message: `Fetched ${filteredIssues.length} Linear issue${
      filteredIssues.length === 1 ? "" : "s"
    } updated since ${sinceIso}.`,
    rawFiles,
    runId,
    state,
    status: "success",
    warnings,
  });
}

async function finishLinearRun({
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
    "linear",
    updateStateWithRun(state, {
      at: new Date().toISOString(),
      rawFiles,
      runId,
      status,
      warnings,
    }),
  );

  return {
    connectorId: "linear",
    message,
    rawFiles,
    runId,
    statePath: `${openWikiConnectorsDisplayPath}/linear/state.json`,
    status,
    warnings,
  };
}

async function fetchIssues(
  apiKey: string,
  fetchOptions: {
    includeDescription: boolean;
    limit: number;
    sinceIso: string;
    teams: string[];
  },
): Promise<LinearIssue[]> {
  const response = await fetchWithResilience(LINEAR_GRAPHQL_URL, {
    body: JSON.stringify({
      query: ISSUES_QUERY,
      variables: {
        first: fetchOptions.limit,
        since: fetchOptions.sinceIso,
        // An empty `in` filter matches nothing in Linear's semantics, so an
        // unfiltered run must omit the variable entirely.
        ...(fetchOptions.teams.length > 0 ? { teams: fetchOptions.teams } : {}),
      },
    }),
    headers: {
      Authorization: apiKey,
      "Content-Type": "application/json",
    },
    method: "POST",
  });

  if (!response.ok) {
    throw new Error(
      `Linear API request failed: ${response.status} ${response.statusText}`,
    );
  }

  const payload = (await response.json()) as GraphQLResponse<IssuesQueryResult>;
  if (payload.errors !== undefined && payload.errors.length > 0) {
    throw new Error(
      `Linear API error: ${payload.errors.map((e) => e.message).join("; ")}`,
    );
  }

  return (payload.data?.issues?.nodes ?? []).map((node) => ({
    assigneeName: node.assignee?.displayName,
    description: fetchOptions.includeDescription
      ? truncate(node.description)
      : undefined,
    identifier: node.identifier,
    labels: (node.labels?.nodes ?? [])
      .map((label) => label.name)
      .filter((name): name is string => typeof name === "string"),
    projectName: node.project?.name,
    stateName: node.state?.name,
    teamKey: node.team?.key,
    title: node.title,
    updatedAt: node.updatedAt,
    url: node.url,
  }));
}

/** Caps long issue bodies so one epic's description cannot dominate the dump. */
function truncate(value: string | undefined): string | undefined {
  const trimmed = value?.trim();

  return trimmed && trimmed.length > 0
    ? trimmed.length > 2_000
      ? `${trimmed.slice(0, 2_000)}…`
      : trimmed
    : undefined;
}

function normalizeLimit(
  optionLimit: number | undefined,
  configLimit: number | undefined,
): number {
  const limit = optionLimit ?? configLimit ?? 50;

  return Math.max(1, Math.min(250, Math.trunc(limit)));
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
