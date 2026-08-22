import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const tempHomes: string[] = [];

type RssDump = {
  feeds: {
    items: { publishedAt?: string; title?: string }[];
    kind: string;
    url: string;
  }[];
  windowHours: number | null;
};

async function createTempHome(): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), "openwiki-rss-"));
  tempHomes.push(home);
  return home;
}

async function writeRssConfig(home: string, config: unknown): Promise<void> {
  const dir = path.join(home, ".openwiki", "connectors", "rss");
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "config.json"),
    `${JSON.stringify(config, null, 2)}\n`,
    "utf8",
  );
}

function setConnectorTestHome(home: string): void {
  process.env.HOME = home;
  process.env.USERPROFILE = home;
}

async function loadRssConnector(home: string) {
  vi.resetModules();
  setConnectorTestHome(home);
  const { createRssConnector } =
    await import("../../../src/connectors/sources/rss.ts");
  return createRssConnector();
}

const FRESH_PUB_DATE = new Date(Date.now() - 60 * 60 * 1000).toUTCString();

const RSS_SAMPLE = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <title>Acme Blog &amp; Notes</title>
  <item>
    <title><![CDATA[Shipping the v2 API]]></title>
    <link>https://acme.example/blog/v2-api</link>
    <pubDate>${FRESH_PUB_DATE}</pubDate>
    <description><![CDATA[<p>We shipped <b>v2</b> &amp; migrated everyone.</p>]]></description>
  </item>
  <item>
    <title>Older post</title>
    <link>https://acme.example/blog/older</link>
    <pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate>
    <description>Historical context.</description>
  </item>
</channel></rss>`;

const ATOM_SAMPLE = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Status Page</title>
  <entry>
    <title>All systems operational</title>
    <link href="https://status.example/incident/42" />
    <updated>2026-08-20T09:30:00Z</updated>
    <summary>Resolved &lt;quickly&gt;</summary>
  </entry>
</feed>`;

afterEach(async () => {
  vi.resetModules();
  vi.unstubAllGlobals();

  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  if (originalUserProfile === undefined) {
    delete process.env.USERPROFILE;
  } else {
    process.env.USERPROFILE = originalUserProfile;
  }

  await Promise.all(
    tempHomes
      .splice(0)
      .map((home) => rm(home, { force: true, recursive: true })),
  );
});

describe("rss connector ingestion", () => {
  test("parses RSS 2.0 items with CDATA, entities, and HTML summaries", async () => {
    const home = await createTempHome();
    stubFeedResponses({ "https://acme.example/feed.xml": RSS_SAMPLE });
    const connector = await loadRssConnector(home);

    const result = await connector.ingest({
      connectorConfig: { feeds: ["https://acme.example/feed.xml"] },
    });

    expect(result.status).toBe("success");
    expect(result.warnings).toEqual([]);

    const dump = JSON.parse(
      await readFile(result.rawFiles[0] ?? "", "utf8"),
    ) as RssDump;
    const [feed] = dump.feeds;
    expect(feed?.kind).toBe("rss");
    expect(feed?.url).toBe("https://acme.example/feed.xml");
    expect(dump.feeds[0]?.items).toHaveLength(2);

    const [first] = dump.feeds[0]?.items ?? [];
    expect(first?.title).toBe("Shipping the v2 API");
    // The dynamic sample date round-trips RFC-822 → ISO.
    expect(first?.publishedAt).toBe(new Date(FRESH_PUB_DATE).toISOString());
  });

  test("parses Atom entries using href links and updated timestamps", async () => {
    const home = await createTempHome();
    stubFeedResponses({ "https://status.example/atom.xml": ATOM_SAMPLE });
    const connector = await loadRssConnector(home);

    const result = await connector.ingest({
      connectorConfig: { feeds: ["https://status.example/atom.xml"] },
    });

    expect(result.status).toBe("success");

    const dump = JSON.parse(
      await readFile(result.rawFiles[0] ?? "", "utf8"),
    ) as RssDump;
    const [item] = dump.feeds[0]?.items ?? [];
    expect(item?.title).toBe("All systems operational");
    expect(item?.publishedAt).toBe("2026-08-20T09:30:00.000Z");
  });

  test("applies the time window to drop stale items", async () => {
    const home = await createTempHome();
    stubFeedResponses({ "https://acme.example/feed.xml": RSS_SAMPLE });
    const connector = await loadRssConnector(home);

    const result = await connector.ingest({
      connectorConfig: { feeds: ["https://acme.example/feed.xml"] },
      windowHours: 24,
    });

    expect(result.status).toBe("success");
    const dump = JSON.parse(
      await readFile(result.rawFiles[0] ?? "", "utf8"),
    ) as RssDump;
    // The 2024 post falls outside the 24h window; the 2026 post survives.
    expect(dump.feeds[0]?.items.map((item) => item.title)).toEqual([
      "Shipping the v2 API",
    ]);
    expect(dump.windowHours).toBe(24);
  });

  test("downgrades a failing feed to a warning and still writes results", async () => {
    const home = await createTempHome();
    stubFeedResponses({ "https://good.example/feed.xml": RSS_SAMPLE });
    const connector = await loadRssConnector(home);

    const result = await connector.ingest({
      connectorConfig: {
        feeds: ["https://good.example/feed.xml", "https://bad.example/feed"],
      },
    });

    expect(result.status).toBe("success");
    expect(
      result.warnings.some((warning) =>
        warning.startsWith("https://bad.example/feed:"),
      ),
    ).toBe(true);
  });
});

describe("rss connector gating and validation", () => {
  test("skips without fetching when the connector is disabled", async () => {
    const home = await createTempHome();
    await writeRssConfig(home, { enabled: false });
    const fetchMock = vi.fn(() => {
      throw new Error("fetch should not be called");
    });
    vi.stubGlobal("fetch", fetchMock);
    const connector = await loadRssConnector(home);

    const result = await connector.ingest();

    expect(result.status).toBe("skipped");
    expect(result.message).toContain("not enabled");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("errors without raw output when no valid feeds are configured", async () => {
    const home = await createTempHome();
    const fetchMock = vi.fn(() => {
      throw new Error("fetch should not be called");
    });
    vi.stubGlobal("fetch", fetchMock);
    const connector = await loadRssConnector(home);

    const result = await connector.ingest();

    expect(result.status).toBe("error");
    expect(result.rawFiles).toEqual([]);
    expect(result.message).toContain("No valid RSS or Atom feed URLs");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("warns about invalid feed URLs and keeps the valid ones", async () => {
    const home = await createTempHome();
    stubFeedResponses({ "ftp://old.example/feed": "<rss></rss>" });
    const connector = await loadRssConnector(home);

    const result = await connector.ingest({
      connectorConfig: {
        feeds: ["not-a-url", "https://ok.example/feed", ""],
      },
    });

    expect(result.status).toBe("success");
    expect(
      result.warnings.some((warning) =>
        warning.includes("Ignored invalid RSS feed URL(s): not-a-url"),
      ),
    ).toBe(true);
    // The valid feed must still have been fetched.
    expect(
      getStubbedRequestPaths().some((pathName) =>
        pathName.endsWith("ok.example/feed"),
      ),
    ).toBe(true);
  });
});

let stubbedFetch: ReturnType<typeof vi.fn> | null = null;

function stubFeedResponses(responses: Record<string, string>): void {
  stubbedFetch = vi.fn((input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    const body = responses[url];

    return Promise.resolve(
      body !== undefined
        ? new Response(body, { status: 200 })
        : new Response("not found", { status: 404 }),
    );
  });
  vi.stubGlobal("fetch", stubbedFetch);
}

function getStubbedResponses(): ReturnType<typeof vi.fn> {
  if (stubbedFetch === null) {
    throw new Error("stubFeedResponses was not called yet");
  }

  return stubbedFetch;
}

function getStubbedRequestPaths(): string[] {
  const calls = getStubbedResponses().mock.calls as [string | URL][];
  return calls.map(([input]) =>
    input instanceof URL ? input.href : String(input),
  );
}
