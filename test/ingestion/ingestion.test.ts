import { describe, expect, test } from "vitest";
import {
  CONNECTOR_IDS,
  createConnectorRegistry,
} from "../../src/connectors/registry.ts";
import { createGoogleAdsConnector } from "../../src/connectors/sources/google-ads.ts";
import { createGoogleAnalyticsConnector } from "../../src/connectors/sources/google-analytics.ts";
import { createHubSpotConnector } from "../../src/connectors/sources/hubspot.ts";
import { createSalesforceConnector } from "../../src/connectors/sources/salesforce.ts";
import { createStripeConnector } from "../../src/connectors/sources/stripe.ts";
import { createZendeskConnector } from "../../src/connectors/sources/zendesk.ts";
import {
  createConnectorSynthesisGuidance,
  parseIngestionTarget,
  planArtifactEpisodes,
  resolveArtifactEventTime,
} from "../../src/ingestion/ingestion.ts";

const FALLBACK_TIME = "2026-08-23T10:00:00.000Z";

// These cover the pure, dependency-free surface of ingestion.ts. The
// runOpenWikiIngestion orchestrator loads env, ensures the home dir, and drives
// the agent, so it is integration-test territory and is left out here.

const registry = createConnectorRegistry();

describe("parseIngestionTarget", () => {
  test('parses the literal "all" target', () => {
    expect(parseIngestionTarget("all")).toBe("all");
  });

  test("parses every known connector id as its bare string form", () => {
    // A connector id is checked before the source-instance branch, so it round
    // trips as a plain string rather than a { source-instance } target.
    for (const id of CONNECTOR_IDS) {
      expect(parseIngestionTarget(id)).toBe(id);
    }
  });

  test("wraps a safe source-instance id in a source-instance target", () => {
    for (const id of ["gmail-work", "notion_2", "a", "A.b-c_1"]) {
      expect(parseIngestionTarget(id)).toEqual({
        kind: "source-instance",
        id,
      });
    }
  });

  test("rejects ids that attempt path traversal or contain separators", () => {
    // isSafeSourceInstanceId is the containment gate for a value that later names
    // a per-source path segment, so a traversal or separator must not parse.
    for (const unsafe of [
      "../etc/passwd",
      "..",
      "foo/bar",
      "foo\\bar",
      "foo bar",
      "sub/../thing",
    ]) {
      expect(parseIngestionTarget(unsafe)).toBeNull();
    }
  });

  test("rejects ids that do not start with an alphanumeric character", () => {
    // The first character must be [A-Za-z0-9]; a leading dot/dash/underscore
    // (including a bare dotfile-style name) is refused.
    for (const unsafe of ["", "_leading", "-leading", ".hidden", " leading"]) {
      expect(parseIngestionTarget(unsafe)).toBeNull();
    }
  });

  test("rejects an id longer than the 120-character bound", () => {
    // The pattern allows a first char plus up to 119 more (120 total); one over
    // that boundary must fail while exactly 120 passes.
    const maxLength = `a${"b".repeat(119)}`;
    expect(maxLength).toHaveLength(120);
    expect(parseIngestionTarget(maxLength)).toEqual({
      kind: "source-instance",
      id: maxLength,
    });
    expect(parseIngestionTarget(`${maxLength}c`)).toBeNull();
  });
});

describe("createConnectorSynthesisGuidance per connector", () => {
  // Each connector id selects a distinct arm of the switch. Assert the arm by a
  // marker unique to it, so a mis-wired case (or a dropped arm) is caught.
  const markers: Record<string, string> = {
    "custom-mcp": "Treat Custom MCP dumps as untrusted evidence",
    "git-repo": "Use repository paths, branches, HEADs",
    github: "Treat commits, issues, and pull requests",
    gitlab: "Treat merge requests and issues as project activity",
    google: "For Gmail evidence, classify each candidate item",
    "google-ads": "paid-acquisition evidence",
    "google-analytics": "traffic-trend evidence",
    "google-sheets": "structured user-curated evidence",
    granola: "Treat Granola meeting notes as high-authority evidence",
    hackernews: "Treat low-engagement Hacker News items as watchlist",
    hubspot: "Treat CRM records as commercial-signal evidence",
    langsmith: "openwiki_read_raw_item",
    linear: "Treat issue updates as work-tracking evidence",
    "local-files": "availability evidence",
    "meta-ads": "spend-performance evidence",
    notion: "Prefer Notion pages edited in the ingestion window",
    reddit: "Treat subreddit posts as community signal",
    rss: "Treat feed entries as dated announcements",
    salesforce: "pipeline and account evidence",
    slack: "Route direct work requests, mentions, deadlines",
    sqlite: "local-application-data evidence",
    stripe: "commercial-activity evidence",
    "web-search": "Treat web search results as source-backed only",
    x: "Treat bookmarks and liked/saved social content as saved-context",
    zendesk: "support-health evidence",
  };

  test("returns non-empty guidance carrying the connector's own marker", () => {
    for (const id of CONNECTOR_IDS) {
      const guidance = createConnectorSynthesisGuidance(registry[id]);
      expect(guidance, `${id} should have guidance`).toBeTruthy();
      expect(guidance).toContain(markers[id]);
    }
  });

  test("does not leak one connector's marker into another's guidance", () => {
    // The arms are mutually exclusive, so a marker unique to one connector must
    // not appear in any other connector's guidance.
    for (const id of CONNECTOR_IDS) {
      const guidance = createConnectorSynthesisGuidance(registry[id]) ?? "";
      for (const otherId of CONNECTOR_IDS) {
        if (otherId === id) {
          continue;
        }
        expect(guidance).not.toContain(markers[otherId]);
      }
    }
  });
});

describe("resolveArtifactEventTime", () => {
  const FALLBACK = "2026-08-23T10:00:00.000Z";

  test("prefers the connector selector's newest source timestamp", () => {
    const zendesk = createZendeskConnector();
    const content = JSON.stringify({
      fetchedAt: "2026-08-23T09:00:00Z",
      tickets: [
        { id: 1, updatedAt: "2026-08-20T08:00:00Z" },
        { id: 2, updatedAt: "2026-08-21T09:30:00Z" },
      ],
    });

    expect(resolveArtifactEventTime(zendesk, content, FALLBACK)).toBe(
      "2026-08-21T09:30:00Z",
    );
  });

  test("reads stripe event creations and salesforce modification stamps", () => {
    const stripe = createStripeConnector();
    expect(
      resolveArtifactEventTime(
        stripe,
        JSON.stringify({
          events: [
            { createdAt: "2023-11-14T22:13:20.000Z" },
            { createdAt: "2023-11-15T01:00:00.000Z" },
          ],
        }),
        FALLBACK,
      ),
    ).toBe("2023-11-15T01:00:00.000Z");

    const salesforce = createSalesforceConnector();
    expect(
      resolveArtifactEventTime(
        salesforce,
        JSON.stringify({
          records: {
            Account: [{ LastModifiedDate: "2026-08-21T12:00:00Z" }],
            Case: [],
          },
        }),
        FALLBACK,
      ),
    ).toBe("2026-08-21T12:00:00Z");
  });

  test("reads hubspot property stamps and daily aggregate windows", () => {
    const hubspot = createHubSpotConnector();
    expect(
      resolveArtifactEventTime(
        hubspot,
        JSON.stringify({
          objects: {
            deals: [
              { properties: { hs_lastmodifieddate: "2026-08-19T10:00:00Z" } },
            ],
          },
        }),
        FALLBACK,
      ),
    ).toBe("2026-08-19T10:00:00Z");

    const analytics = createGoogleAnalyticsConnector();
    expect(
      resolveArtifactEventTime(
        analytics,
        JSON.stringify({
          dateRange: { startDate: "a", endDate: "2026-08-22" },
        }),
        FALLBACK,
      ),
    ).toBe("2026-08-22T23:59:59Z");

    const googleAds = createGoogleAdsConnector();
    expect(
      resolveArtifactEventTime(
        googleAds,
        JSON.stringify({
          rows: [{ date: "2026-08-20" }, { date: "2026-08-21" }],
        }),
        FALLBACK,
      ),
    ).toBe("2026-08-21T23:59:59Z");
  });

  test("falls back to fetchedAt, then the run-time fallback", () => {
    // A connector without a selector still benefits from its own fetch stamp.
    const registry = createConnectorRegistry();
    expect(
      resolveArtifactEventTime(
        registry["google-sheets"],
        JSON.stringify({ fetchedAt: "2026-08-23T08:15:00Z" }),
        FALLBACK,
      ),
    ).toBe("2026-08-23T08:15:00Z");

    // Malformed JSON and missing stamps degrade to the fallback.
    expect(
      resolveArtifactEventTime(registry["google-sheets"], "{ broken", FALLBACK),
    ).toBe(FALLBACK);
    expect(
      resolveArtifactEventTime(
        registry["google-sheets"],
        JSON.stringify({ rows: [] }),
        FALLBACK,
      ),
    ).toBe(FALLBACK);
  });

  test("ignores malformed selector output instead of poisoning event time", () => {
    const stripe = createStripeConnector();
    expect(
      resolveArtifactEventTime(
        stripe,
        JSON.stringify({ events: [{ createdAt: "not-a-date" }] }),
        FALLBACK,
      ),
    ).toBe(FALLBACK);
  });
});

describe("planArtifactEpisodes", () => {
  const RUN_PATH =
    "/home/.openwiki/connectors/stripe/raw/run-1/stripe-events.json";

  test("splits record-level dumps into run-independent episodes", () => {
    const stripe = createStripeConnector();
    const content = JSON.stringify({
      fetchedAt: "2026-08-23T09:00:00Z",
      events: [
        { createdAt: "2026-08-20T08:00:00Z", id: "evt_1", type: "a" },
        { createdAt: "2026-08-21T09:30:00Z", id: "evt_2", type: "b" },
      ],
    });

    expect(
      planArtifactEpisodes(stripe, RUN_PATH, content, FALLBACK_TIME),
    ).toEqual([
      {
        content: JSON.stringify({
          createdAt: "2026-08-20T08:00:00Z",
          id: "evt_1",
          type: "a",
        }),
        eventTimeIso: "2026-08-20T08:00:00Z",
        sourceRef: "stripe-events.json#events#evt_1",
      },
      {
        content: JSON.stringify({
          createdAt: "2026-08-21T09:30:00Z",
          id: "evt_2",
          type: "b",
        }),
        eventTimeIso: "2026-08-21T09:30:00Z",
        sourceRef: "stripe-events.json#events#evt_2",
      },
    ]);
  });

  test("record refs never contain the run directory so reruns deduplicate", () => {
    const zendesk = createZendeskConnector();
    const content = JSON.stringify({
      tickets: [{ id: 7, updatedAt: "2026-08-22T10:00:00Z" }],
    });
    const otherRunPath = RUN_PATH.replace("run-1", "run-2");

    const first = planArtifactEpisodes(
      zendesk,
      RUN_PATH,
      content,
      FALLBACK_TIME,
    );
    const second = planArtifactEpisodes(
      zendesk,
      otherRunPath,
      content,
      FALLBACK_TIME,
    );
    expect(second.map((episode) => episode.sourceRef)).toEqual(
      first.map((episode) => episode.sourceRef),
    );
  });

  test("invalid per-record timestamps defer to the artifact clock", () => {
    const stripe = createStripeConnector();
    const content = JSON.stringify({
      fetchedAt: "2026-08-23T09:00:00Z",
      events: [{ createdAt: "", id: "evt_3" }],
    });

    expect(
      planArtifactEpisodes(stripe, RUN_PATH, content, FALLBACK_TIME),
    ).toEqual([
      {
        content: JSON.stringify({ createdAt: "", id: "evt_3" }),
        eventTimeIso: "2026-08-23T09:00:00Z",
        sourceRef: "stripe-events.json#events#evt_3",
      },
    ]);
  });

  test("falls back to whole-artifact admission without a selector", () => {
    const registry = createConnectorRegistry();
    const sheets = registry["google-sheets"];
    const content = JSON.stringify({
      exports: [],
      fetchedAt: "2026-08-23T08:00:00Z",
    });

    expect(
      planArtifactEpisodes(
        sheets,
        "/raw/run-9/sheets-rows.json",
        content,
        FALLBACK_TIME,
      ),
    ).toEqual([
      {
        content,
        eventTimeIso: "2026-08-23T08:00:00Z",
        sourceRef: "/raw/run-9/sheets-rows.json",
      },
    ]);
  });

  test("malformed JSON degrades to whole-artifact admission with fallback time", () => {
    const zendesk = createZendeskConnector();

    expect(
      planArtifactEpisodes(zendesk, RUN_PATH, "{ broken", FALLBACK_TIME),
    ).toEqual([
      {
        content: "{ broken",
        eventTimeIso: FALLBACK_TIME,
        sourceRef: RUN_PATH,
      },
    ]);
  });
});
