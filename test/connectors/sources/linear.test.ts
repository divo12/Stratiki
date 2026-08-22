import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalApiKey = process.env.LINEAR_API_KEY;
const tempHomes: string[] = [];

type LinearDump = {
  issues: {
    identifier?: string;
    labels: string[];
    title?: string;
  }[];
  teams: string[];
};

async function createTempHome(): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), "openwiki-linear-"));
  tempHomes.push(home);
  return home;
}

function setConnectorTestHome(home: string): void {
  process.env.HOME = home;
  process.env.USERPROFILE = home;
}

async function loadLinearConnector(home: string) {
  vi.resetModules();
  setConnectorTestHome(home);
  const { createLinearConnector } =
    await import("../../../src/connectors/sources/linear.ts");
  return createLinearConnector();
}

const ISSUES_RESPONSE = {
  data: {
    issues: {
      nodes: [
        {
          assignee: { displayName: "Jane" },
          identifier: "ACME-12",
          labels: { nodes: [{ name: "launch" }] },
          project: { name: "Platform" },
          state: { name: "In Progress" },
          team: { key: "ENG" },
          title: "Ship billing migration",
          updatedAt: "2026-08-21T10:00:00Z",
          url: "https://linear.app/acme/issue/ACME-12",
        },
        {
          identifier: "ACME-13",
          labels: { nodes: [] },
          state: { name: "Todo" },
          team: { key: "ENG" },
          title: "Investigate flaky tests",
          updatedAt: "2026-08-21T09:00:00Z",
        },
      ],
    },
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
  if (originalApiKey === undefined) {
    delete process.env.LINEAR_API_KEY;
  } else {
    process.env.LINEAR_API_KEY = originalApiKey;
  }

  await Promise.all(
    tempHomes
      .splice(0)
      .map((home) => rm(home, { force: true, recursive: true })),
  );
});

describe("linear connector ingestion", () => {
  test("fetches issues with the API key and maps nodes", async () => {
    process.env.LINEAR_API_KEY = "lin_api_test";
    const home = await createTempHome();
    const requests: { authorization: string | undefined; body: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        requests.push({
          authorization:
            new Headers(init?.headers).get("Authorization") ?? undefined,
          body: typeof init?.body === "string" ? init.body : "",
        });
        return Promise.resolve(jsonResponse(ISSUES_RESPONSE));
      }),
    );
    const connector = await loadLinearConnector(home);

    const result = await connector.ingest({ windowHours: 24 });

    expect(result.status).toBe("success");
    expect(result.warnings).toEqual([]);

    const [request] = requests;
    expect(request?.authorization).toBe("lin_api_test");
    expect(request?.body).toContain('"first":50');
    expect(request?.body).toContain("updatedAt");

    const dump = JSON.parse(
      await readFile(result.rawFiles[0] ?? "", "utf8"),
    ) as LinearDump;
    expect(dump.issues).toHaveLength(2);
    expect(dump.issues[0]?.identifier).toBe("ACME-12");
    expect(dump.issues[0]?.labels).toEqual(["launch"]);
    expect(dump.teams).toEqual([]);
  });

  test("passes configured teams in the GraphQL variables", async () => {
    process.env.LINEAR_API_KEY = "lin_api_test";
    const home = await createTempHome();
    const bodies: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: string | URL | Request, init?: RequestInit) => {
        bodies.push(typeof init?.body === "string" ? init.body : "");
        return Promise.resolve(
          jsonResponse({ data: { issues: { nodes: [] } } }),
        );
      }),
    );
    const connector = await loadLinearConnector(home);

    const result = await connector.ingest({
      connectorConfig: { teams: ["ENG", "DES"] },
    });

    expect(result.status).toBe("success");
    expect(bodies[0]).toContain('"teams":["ENG","DES"]');
  });

  test("filters by project name client-side", async () => {
    process.env.LINEAR_API_KEY = "lin_api_test";
    const home = await createTempHome();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(jsonResponse(ISSUES_RESPONSE))),
    );
    const connector = await loadLinearConnector(home);

    const result = await connector.ingest({
      connectorConfig: { projects: ["Platform"] },
    });

    expect(result.status).toBe("success");
    const dump = JSON.parse(
      await readFile(result.rawFiles[0] ?? "", "utf8"),
    ) as LinearDump;
    expect(dump.issues.map((issue) => issue.identifier)).toEqual(["ACME-12"]);
  });
});

describe("linear connector gating and validation", () => {
  test("errors without fetching when LINEAR_API_KEY is missing", async () => {
    delete process.env.LINEAR_API_KEY;
    const home = await createTempHome();
    const fetchMock = vi.fn(() => {
      throw new Error("fetch should not be called");
    });
    vi.stubGlobal("fetch", fetchMock);
    const connector = await loadLinearConnector(home);

    const result = await connector.ingest();

    expect(result.status).toBe("error");
    expect(result.message).toContain("LINEAR_API_KEY");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("skips without fetching when disabled", async () => {
    const home = await createTempHome();
    const fetchMock = vi.fn(() => {
      throw new Error("fetch should not be called");
    });
    vi.stubGlobal("fetch", fetchMock);
    const connector = await loadLinearConnector(home);

    const result = await connector.ingest({
      connectorConfig: { enabled: false },
    });

    expect(result.status).toBe("skipped");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("surfaces GraphQL errors as warnings and still writes results", async () => {
    process.env.LINEAR_API_KEY = "lin_api_test";
    const home = await createTempHome();
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          jsonResponse({ errors: [{ message: "authentication expired" }] }),
        ),
      ),
    );
    const connector = await loadLinearConnector(home);

    const result = await connector.ingest();

    expect(result.status).toBe("success");
    expect(result.warnings.join("\n")).toContain("authentication expired");
  });
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
    status: 200,
  });
}
