import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalGithubToken = process.env.GITHUB_TOKEN;
const originalGhToken = process.env.GH_TOKEN;
const tempHomes: string[] = [];

type GitHubDump = {
  repos: {
    activity: {
      commits: { message?: string; sha?: string }[];
      issues: { number?: number }[];
      pullRequests: { number?: number }[];
    };
    repo: string;
  }[];
};

async function createTempHome(): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), "openwiki-github-"));
  tempHomes.push(home);
  return home;
}

function setConnectorTestHome(home: string): void {
  process.env.HOME = home;
  process.env.USERPROFILE = home;
}

async function loadGithubConnector(home: string) {
  vi.resetModules();
  setConnectorTestHome(home);
  const { createGithubConnector } =
    await import("../../../src/connectors/sources/github.ts");
  return createGithubConnector();
}

const COMMITS_SAMPLE = [
  {
    html_url: "https://github.com/acme/api/commit/abc123def456",
    sha: "abc123def4567890",
    commit: { message: "Fix token refresh race\n\nLonger body." },
    author: { login: "jane" },
  },
];

const ISSUES_SAMPLE = [
  {
    html_url: "https://github.com/acme/api/issues/7",
    number: 7,
    state: "open",
    title: "Rate limiter flaky",
    updated_at: "2026-08-19T12:00:00Z",
    labels: [{ name: "bug" }, { name: "api" }],
  },
  {
    html_url: "https://github.com/acme/api/pull/8",
    number: 8,
    state: "open",
    title: "Add retry policy",
    updated_at: "2026-08-20T08:00:00Z",
    labels: [],
    pull_request: { merged_at: null },
  },
];

afterEach(async () => {
  vi.resetModules();
  vi.unstubAllGlobals();

  for (const key of ["HOME", "USERPROFILE"] as const) {
    const original = key === "HOME" ? originalHome : originalUserProfile;
    if (original === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = original;
    }
  }
  if (originalGithubToken === undefined) {
    delete process.env.GITHUB_TOKEN;
  } else {
    process.env.GITHUB_TOKEN = originalGithubToken;
  }
  if (originalGhToken === undefined) {
    delete process.env.GH_TOKEN;
  } else {
    process.env.GH_TOKEN = originalGhToken;
  }

  await Promise.all(
    tempHomes
      .splice(0)
      .map((home) => rm(home, { force: true, recursive: true })),
  );
});

describe("github connector ingestion", () => {
  test("splits issues and pull requests and truncates commit messages", async () => {
    const home = await createTempHome();
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const requestUrl = new URL(
          input instanceof Request ? input.url : String(input),
        );
        if (requestUrl.pathname.endsWith("/commits")) {
          return Promise.resolve(jsonResponse(COMMITS_SAMPLE));
        }
        if (requestUrl.pathname.endsWith("/issues")) {
          return Promise.resolve(jsonResponse(ISSUES_SAMPLE));
        }
        return Promise.resolve(jsonResponse([]));
      }),
    );
    const connector = await loadGithubConnector(home);

    const result = await connector.ingest({
      connectorConfig: { repos: ["acme/api"], maxPerRepo: 10 },
    });

    expect(result.status).toBe("success");
    // The only expected warning is the missing-token rate-limit notice.
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("No GITHUB_TOKEN");

    const dump = JSON.parse(
      await readFile(result.rawFiles[0] ?? "", "utf8"),
    ) as GitHubDump;
    const [repoResult] = dump.repos;
    expect(repoResult?.repo).toBe("acme/api");

    const [commit] = repoResult?.activity.commits ?? [];
    expect(commit?.message).toBe("Fix token refresh race");
    expect(commit?.sha).toBe("abc123def456");

    // Issue #7 has no pull_request key; PR #8 is separated out.
    expect(repoResult?.activity.issues.map((issue) => issue.number)).toEqual([
      7,
    ]);
    expect(
      repoResult?.activity.pullRequests.map((pull) => pull.number),
    ).toEqual([8]);

    // Unauthenticated runs must warn about rate limits.
    expect(result.warnings.join("\n")).toContain("No GITHUB_TOKEN");
  });

  test("sends a bearer token when GITHUB_TOKEN is set", async () => {
    process.env.GITHUB_TOKEN = "ghs_test_token_123";
    const home = await createTempHome();
    const authHeaders: (string | undefined)[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        const headerBag = new Headers(init?.headers);
        authHeaders.push(headerBag.get("Authorization") ?? undefined);
        const requestUrl = new URL(
          input instanceof Request ? input.url : String(input),
        );
        if (requestUrl.pathname.endsWith("/commits")) {
          return Promise.resolve(jsonResponse([]));
        }
        if (requestUrl.pathname.endsWith("/issues")) {
          return Promise.resolve(jsonResponse([]));
        }
        return Promise.resolve(jsonResponse([]));
      }),
    );
    const connector = await loadGithubConnector(home);

    await connector.ingest({ connectorConfig: { repos: ["acme/api"] } });

    expect(authHeaders.length).toBeGreaterThan(0);
    expect(
      authHeaders.every((value) => value === "Bearer ghs_test_token_123"),
    ).toBe(true);
  });

  test("passes the window as the since parameter", async () => {
    const home = await createTempHome();
    const requestedUrls: URL[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = new URL(
          input instanceof Request ? input.url : String(input),
        );
        requestedUrls.push(url);
        return Promise.resolve(jsonResponse([]));
      }),
    );
    const connector = await loadGithubConnector(home);

    const result = await connector.ingest({
      connectorConfig: { repos: ["acme/api"] },
      windowHours: 24,
    });

    expect(result.status).toBe("success");
    const sinceValues = requestedUrls
      .map((url) => url.searchParams.get("since"))
      .filter((value): value is string => value !== null);
    expect(sinceValues.length).toBe(2);
    expect(
      sinceValues.every((value) => /^\d{4}-\d{2}-\d{2}T/u.test(value)),
    ).toBe(true);
  });
});

describe("github connector gating and validation", () => {
  test("skips without fetching when disabled", async () => {
    const home = await createTempHome();
    await writeGithubConfig(home, { enabled: false });
    const fetchMock = vi.fn(() => {
      throw new Error("fetch should not be called");
    });
    vi.stubGlobal("fetch", fetchMock);
    const connector = await loadGithubConnector(home);

    const result = await connector.ingest();

    expect(result.status).toBe("skipped");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("errors without raw output when no valid repos are configured", async () => {
    const home = await createTempHome();
    const fetchMock = vi.fn(() => {
      throw new Error("fetch should not be called");
    });
    vi.stubGlobal("fetch", fetchMock);
    const connector = await loadGithubConnector(home);

    const result = await connector.ingest({
      connectorConfig: { repos: ["just-a-name", ""] },
    });

    expect(result.status).toBe("error");
    expect(result.rawFiles).toEqual([]);
    expect(result.message).toContain("No valid GitHub repositories");
    expect(result.warnings.join("\n")).toContain(
      "Ignored invalid GitHub repo(s)",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("downgrades a failing repo to a warning and still writes results", async () => {
    const home = await createTempHome();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response("nope", { status: 500 }))),
    );
    const connector = await loadGithubConnector(home);

    const result = await connector.ingest({
      connectorConfig: { repos: ["acme/api"] },
    });

    expect(result.status).toBe("success");
    expect(
      result.warnings.some((warning) =>
        warning.startsWith("acme/api: GitHub API request failed: 500"),
      ),
    ).toBe(true);

    const dump = JSON.parse(
      await readFile(result.rawFiles[0] ?? "", "utf8"),
    ) as GitHubDump;
    expect(dump.repos).toEqual([]);
  });
});

async function writeGithubConfig(home: string, config: unknown): Promise<void> {
  const dir = path.join(home, ".openwiki", "connectors", "github");
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
