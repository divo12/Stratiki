import { createGitRepoConnector } from "./sources/git-repo.js";
import { createGithubConnector } from "./sources/github.js";
import { createGitLabConnector } from "./sources/gitlab.js";
import { createGoogleAdsConnector } from "./sources/google-ads.js";
import { createGoogleAnalyticsConnector } from "./sources/google-analytics.js";
import { createGoogleSheetsConnector } from "./sources/google-sheets.js";
import { createGmailConnector } from "./sources/gmail.js";
import { createGranolaConnector } from "./sources/granola.js";
import { createHubSpotConnector } from "./sources/hubspot.js";
import { createHackerNewsConnector } from "./sources/hackernews.js";
import { createLangSmithConnector } from "./sources/langsmith/index.js";
import { createLinearConnector } from "./sources/linear.js";
import { createLocalFilesConnector } from "./sources/local-files.js";
import { createMetaAdsConnector } from "./sources/meta-ads.js";
import { createMcpConnector } from "./sources/mcp.js";
import { createRedditConnector } from "./sources/reddit.js";
import { createRssConnector } from "./sources/rss.js";
import { createSalesforceConnector } from "./sources/salesforce.js";
import { createSlackConnector } from "./sources/slack.js";
import { createSqliteConnector } from "./sources/sqlite.js";
import { createStripeConnector } from "./sources/stripe.js";
import { createWebSearchConnector } from "./sources/web-search.js";
import { createXConnector } from "./sources/x.js";
import { createZendeskConnector } from "./sources/zendesk.js";
import { openWikiConnectorsDisplayPath } from "../config/openwiki-home.js";
import type { ConnectorId, ConnectorRuntime } from "./types.js";

export const CONNECTOR_IDS = [
  "custom-mcp",
  "git-repo",
  "github",
  "gitlab",
  "google-ads",
  "google-analytics",
  "google-sheets",
  "google",
  "granola",
  "linear",
  "local-files",
  "meta-ads",
  "hubspot",
  "notion",
  "salesforce",
  "sqlite",
  "stripe",
  "x",
  "web-search",
  "hackernews",
  "reddit",
  "rss",
  "zendesk",
  "langsmith",
  "slack",
] as const satisfies readonly ConnectorId[];

export function createConnectorRegistry(): Record<
  ConnectorId,
  ConnectorRuntime
> {
  return {
    "custom-mcp": createMcpConnector({
      description: `Generic read-only MCP knowledge source. Point OpenWiki at any MCP server via ${openWikiConnectorsDisplayPath}/custom-mcp/config.json (HTTP or stdio transport). Prefer allowedTools and/or MCP readOnlyHint; do not guess mutating tools.`,
      displayName: "Custom MCP",
      id: "custom-mcp",
      // Secrets are referenced by env var name in transport.headers / transport.env.
      // Different MCP servers need different credentials, so none are hard-required.
      requiredEnv: [],
    }),
    "git-repo": createGitRepoConnector(),
    github: createGithubConnector(),
    gitlab: createGitLabConnector(),
    "google-ads": createGoogleAdsConnector(),
    "google-analytics": createGoogleAnalyticsConnector(),
    "google-sheets": createGoogleSheetsConnector(),
    google: createGmailConnector(),
    granola: createGranolaConnector(),
    "local-files": createLocalFilesConnector(),
    "meta-ads": createMetaAdsConnector(),
    hackernews: createHackerNewsConnector(),
    hubspot: createHubSpotConnector(),
    salesforce: createSalesforceConnector(),
    sqlite: createSqliteConnector(),
    stripe: createStripeConnector(),
    zendesk: createZendeskConnector(),
    langsmith: createLangSmithConnector(),
    linear: createLinearConnector(),
    notion: createMcpConnector({
      description:
        "Notion connector backed by the hosted Notion MCP server or another configured read-only MCP server.",
      displayName: "Notion",
      id: "notion",
      requiredEnv: ["OPENWIKI_NOTION_MCP_ACCESS_TOKEN"],
    }),
    reddit: createRedditConnector(),
    rss: createRssConnector(),
    slack: createSlackConnector(),
    "web-search": createWebSearchConnector(),
    x: createXConnector(),
  };
}

export function isConnectorId(value: string): value is ConnectorId {
  return (CONNECTOR_IDS as readonly string[]).includes(value);
}

/**
 * Connector ids that require auth and have all required env vars set. Used by
 * telemetry as an adoption signal.
 */
export function getConfiguredConnectorIds(): ConnectorId[] {
  const registry = createConnectorRegistry();

  return Object.values(registry)
    .filter(
      (connector) =>
        connector.requiredEnv.length > 0 &&
        connector.requiredEnv.every((key) => Boolean(process.env[key])),
    )
    .map((connector) => connector.id);
}
