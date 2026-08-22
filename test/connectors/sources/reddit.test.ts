import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const tempHomes: string[] = [];

type RedditDump = {
  feeds: { items: { title?: string }[]; subreddit: string }[];
  queryResults: { items: unknown[]; query: string }[];
};

async function createTempHome(): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), "openwiki-reddit-"));
  tempHomes.push(home);
  return home;
}

function setConnectorTestHome(home: string): void {
  process.env.HOME = home;
  process.env.USERPROFILE = home;
}

async function loadRedditConnector(home: string) {
  vi.resetModules();
  setConnectorTestHome(home);
  const { createRedditConnector } =
    await import("../../../src/connectors/sources/reddit.ts");
  return createRedditConnector();
}

const LISTING_SAMPLE = {
  data: {
    children: [
      {
        data: {
          author: "dev_maria",
          created_utc: 1_755_000_000,
          num_comments: 12,
          permalink: "/r/acme/comments/abc/post_one/",
          score: 42,
          selftext: "Body text",
          stickied: false,
          subreddit: "acme",
          title: "Post one",
        },
      },
      {
        data: {
          created_utc: 1_755_000_100,
          stickied: true,
          subreddit: "acme",
          title: "Weekly thread",
        },
      },
    ],
  },
};

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

describe("reddit connector ingestion", () => {
  test("fetches subreddit new posts, filtering stickied posts by default", async () => {
    const home = await createTempHome();
    const requests: { userAgent: string | undefined; url: URL }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(
          input instanceof Request ? input.url : String(input),
        );
        const headerBag = new Headers(init?.headers);
        requests.push({
          userAgent: headerBag.get("User-Agent") ?? undefined,
          url,
        });
        return Promise.resolve(jsonResponse(LISTING_SAMPLE));
      }),
    );
    const connector = await loadRedditConnector(home);

    const result = await connector.ingest({
      connectorConfig: { subreddits: ["acme"] },
    });

    expect(result.status).toBe("success");
    expect(result.warnings).toEqual([]);

    const [request] = requests;
    // Reddit rejects default library user agents; a descriptive UA is required.
    expect(request?.userAgent).toContain("stratiki-connector/");
    expect(request?.url.pathname).toBe("/r/acme/new.json");
    expect(request?.url.searchParams.get("raw_json")).toBe("1");

    const dump = JSON.parse(
      await readFile(result.rawFiles[0] ?? "", "utf8"),
    ) as RedditDump;
    expect(dump.feeds[0]?.subreddit).toBe("acme");
    // The stickied weekly thread is filtered out; the regular post survives
    // with an absolute permalink.
    expect(dump.feeds[0]?.items).toHaveLength(1);
    expect(dump.feeds[0]?.items[0]?.title).toBe("Post one");
  });

  test("keeps stickied posts when includeStickied is enabled", async () => {
    const home = await createTempHome();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(jsonResponse(LISTING_SAMPLE))),
    );
    const connector = await loadRedditConnector(home);

    const result = await connector.ingest({
      connectorConfig: { includeStickied: true, subreddits: ["acme"] },
    });

    expect(result.status).toBe("success");
    const dump = JSON.parse(
      await readFile(result.rawFiles[0] ?? "", "utf8"),
    ) as RedditDump;
    expect(dump.feeds[0]?.items).toHaveLength(2);
  });

  test("runs configured search queries through search.json", async () => {
    const home = await createTempHome();
    const paths: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = new URL(
          input instanceof Request ? input.url : String(input),
        );
        paths.push(url.pathname);
        return Promise.resolve(jsonResponse(LISTING_SAMPLE));
      }),
    );
    const connector = await loadRedditConnector(home);

    const result = await connector.ingest({
      connectorConfig: { queries: ["acme corp"] },
      windowHours: 48,
    });

    expect(result.status).toBe("success");
    expect(paths).toEqual(["/search.json"]);

    const dump = JSON.parse(
      await readFile(result.rawFiles[0] ?? "", "utf8"),
    ) as RedditDump & { queryResults: { query?: string }[] };
    expect(dump.queryResults).toHaveLength(1);
    expect(dump.queryResults[0]?.query).toBe("acme corp");
  });

  test("warns about an invalid sort and falls back to new", async () => {
    const home = await createTempHome();
    const requestedPaths: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        requestedPaths.push(
          new URL(input instanceof Request ? input.url : String(input))
            .pathname,
        );
        return Promise.resolve(jsonResponse(LISTING_SAMPLE));
      }),
    );
    const connector = await loadRedditConnector(home);

    const result = await connector.ingest({
      connectorConfig: { sort: "controversial", subreddits: ["acme"] },
    });

    expect(result.status).toBe("success");
    expect(result.warnings.join("\n")).toContain("Ignored invalid Reddit sort");
    expect(requestedPaths).toEqual(["/r/acme/new.json"]);
  });
});

describe("reddit connector gating and validation", () => {
  test("skips without fetching when disabled", async () => {
    const home = await createTempHome();
    await writeRedditConfig(home, { enabled: false });
    const fetchMock = vi.fn(() => {
      throw new Error("fetch should not be called");
    });
    vi.stubGlobal("fetch", fetchMock);
    const connector = await loadRedditConnector(home);

    const result = await connector.ingest();

    expect(result.status).toBe("skipped");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("errors without raw output when nothing is configured", async () => {
    const home = await createTempHome();
    const fetchMock = vi.fn(() => {
      throw new Error("fetch should not be called");
    });
    vi.stubGlobal("fetch", fetchMock);
    const connector = await loadRedditConnector(home);

    const result = await connector.ingest();

    expect(result.status).toBe("error");
    expect(result.rawFiles).toEqual([]);
    expect(result.message).toContain("No Reddit subreddits or search queries");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("downgrades a failing subreddit to a warning and still writes results", async () => {
    const home = await createTempHome();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response("blocked", { status: 403 }))),
    );
    const connector = await loadRedditConnector(home);

    const result = await connector.ingest({
      connectorConfig: { subreddits: ["private"] },
    });

    expect(result.status).toBe("success");
    expect(
      result.warnings.some((warning) =>
        warning.startsWith("r/private: Reddit request failed: 403"),
      ),
    ).toBe(true);
  });
});

async function writeRedditConfig(home: string, config: unknown): Promise<void> {
  const dir = path.join(home, ".openwiki", "connectors", "reddit");
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "config.json"),
    `${JSON.stringify(config, null, 2)}\n`,
    "utf8",
  );
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
    status: 200,
  });
}
