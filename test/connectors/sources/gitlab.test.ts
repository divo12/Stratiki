import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalToken = process.env.GITLAB_TOKEN;
const tempHomes: string[] = [];

type GitLabDump = {
  projects: {
    activity: {
      commits: { message?: string; sha?: string }[];
      issues: unknown[];
      mergeRequests: unknown[];
    };
    project: string;
  }[];
};

async function createTempHome(): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), "openwiki-gitlab-"));
  tempHomes.push(home);
  return home;
}

function setConnectorTestHome(home: string): void {
  process.env.HOME = home;
  process.env.USERPROFILE = home;
}

async function loadGitLabConnector(home: string) {
  vi.resetModules();
  setConnectorTestHome(home);
  const { createGitLabConnector } =
    await import("../../../src/connectors/sources/gitlab.ts");
  return createGitLabConnector();
}

const COMMITS_SAMPLE = [
  {
    author_name: "Jane",
    id: "abc123def4567890",
    message: "Fix MR pipeline\n\nBody.",
    web_url: "https://gitlab.com/acme/api/-/commit/abc123",
  },
];

const MRS_SAMPLE = [
  {
    iid: 4,
    labels: ["backend"],
    state: "opened",
    title: "Add retry policy",
    updated_at: new Date().toISOString(),
    web_url: "https://gitlab.com/acme/api/-/merge_requests/4",
  },
];

const ISSUES_SAMPLE = [
  {
    iid: 9,
    labels: ["bug"],
    state: "opened",
    title: "Rate limiter flaky",
    updated_at: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
    web_url: "https://gitlab.com/acme/api/-/issues/9",
  },
];

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
  if (originalToken === undefined) {
    delete process.env.GITLAB_TOKEN;
  } else {
    process.env.GITLAB_TOKEN = originalToken;
  }

  await Promise.all(
    tempHomes
      .splice(0)
      .map((home) => rm(home, { force: true, recursive: true })),
  );
});

describe("gitlab connector ingestion", () => {
  test("fetches commits, merge requests, and issues for a project", async () => {
    const home = await createTempHome();
    const requestedPaths: string[] = [];
    const privateTokens: (string | null)[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(
          input instanceof Request ? input.url : String(input),
        );
        requestedPaths.push(url.pathname);
        privateTokens.push(new Headers(init?.headers).get("PRIVATE-TOKEN"));
        if (url.pathname.endsWith("/commits")) {
          return Promise.resolve(jsonResponse(COMMITS_SAMPLE));
        }
        if (url.pathname.endsWith("/merge_requests")) {
          return Promise.resolve(jsonResponse(MRS_SAMPLE));
        }
        if (url.pathname.endsWith("/issues")) {
          return Promise.resolve(jsonResponse(ISSUES_SAMPLE));
        }
        return Promise.resolve(jsonResponse([]));
      }),
    );
    const connector = await loadGitLabConnector(home);

    const result = await connector.ingest({
      connectorConfig: { projects: ["acme/api"] },
    });

    expect(result.status).toBe("success");
    // The group/project path must be URL-encoded into the API path.
    expect(
      requestedPaths.every((pathName) =>
        pathName.startsWith("/api/v4/projects/acme%2Fapi/"),
      ),
    ).toBe(true);
    expect(privateTokens.every((value) => value === null)).toBe(true);

    const dump = JSON.parse(
      await readFile(result.rawFiles[0] ?? "", "utf8"),
    ) as GitLabDump;
    const [projectResult] = dump.projects;
    expect(projectResult?.project).toBe("acme/api");

    const [commit] = projectResult?.activity.commits ?? [];
    expect(commit?.message).toBe("Fix MR pipeline");
    expect(commit?.sha).toBe("abc123def456");
    expect(projectResult?.activity.mergeRequests).toHaveLength(1);
    // The issue was last updated 48h ago; the default run has no window, so
    // it survives.
    expect(projectResult?.activity.issues).toHaveLength(1);

    // Unauthenticated runs must warn about rate limits.
    expect(result.warnings.join("\n")).toContain("No GITLAB_TOKEN");
  });

  test("sends PRIVATE-TOKEN when GITLAB_TOKEN is set", async () => {
    process.env.GITLAB_TOKEN = "glpat_test_123";
    const home = await createTempHome();
    const tokens: (string | null)[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        tokens.push(new Headers(init?.headers).get("PRIVATE-TOKEN"));
        const url = new URL(
          input instanceof Request ? input.url : String(input),
        );
        if (url.pathname.endsWith("/commits")) {
          return Promise.resolve(jsonResponse([]));
        }
        return Promise.resolve(jsonResponse([]));
      }),
    );
    const connector = await loadGitLabConnector(home);

    await connector.ingest({ connectorConfig: { projects: ["acme/api"] } });

    expect(tokens.length).toBeGreaterThan(0);
    expect(tokens.every((value) => value === "glpat_test_123")).toBe(true);
  });

  test("applies the window client-side to merge requests and issues", async () => {
    const home = await createTempHome();
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = new URL(
          input instanceof Request ? input.url : String(input),
        );
        if (url.pathname.endsWith("/commits")) {
          return Promise.resolve(jsonResponse(COMMITS_SAMPLE));
        }
        if (url.pathname.endsWith("/merge_requests")) {
          return Promise.resolve(jsonResponse(MRS_SAMPLE));
        }
        if (url.pathname.endsWith("/issues")) {
          return Promise.resolve(jsonResponse(ISSUES_SAMPLE));
        }
        return Promise.resolve(jsonResponse([]));
      }),
    );
    const connector = await loadGitLabConnector(home);

    const result = await connector.ingest({
      connectorConfig: { projects: ["acme/api"] },
      windowHours: 24,
    });

    expect(result.status).toBe("success");
    const dump = JSON.parse(
      await readFile(result.rawFiles[0] ?? "", "utf8"),
    ) as GitLabDump & {
      since: string;
    };
    // The fresh MR survives the 24h window; the stale issue is dropped.
    expect(dump.projects[0]?.activity.mergeRequests).toHaveLength(1);
    expect(dump.projects[0]?.activity.issues).toEqual([]);
    expect(dump.since).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
  });
});

describe("gitlab connector gating and validation", () => {
  test("skips without fetching when disabled", async () => {
    const home = await createTempHome();
    await writeGitLabConfig(home, { enabled: false });
    const fetchMock = vi.fn(() => {
      throw new Error("fetch should not be called");
    });
    vi.stubGlobal("fetch", fetchMock);
    const connector = await loadGitLabConnector(home);

    const result = await connector.ingest();

    expect(result.status).toBe("skipped");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("errors without raw output when no valid projects are configured", async () => {
    const home = await createTempHome();
    const fetchMock = vi.fn(() => {
      throw new Error("fetch should not be called");
    });
    vi.stubGlobal("fetch", fetchMock);
    const connector = await loadGitLabConnector(home);

    const result = await connector.ingest({
      connectorConfig: { projects: ["noslash"] },
    });

    expect(result.status).toBe("error");
    expect(result.rawFiles).toEqual([]);
    expect(result.message).toContain("No valid GitLab projects");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

async function writeGitLabConfig(home: string, config: unknown): Promise<void> {
  const dir = path.join(home, ".openwiki", "connectors", "gitlab");
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
