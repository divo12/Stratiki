import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalToken = process.env.HUBSPOT_TOKEN;
const tempHomes: string[] = [];

type HubSpotDump = {
  objects: Record<string, { id: string; properties: Record<string, string> }[]>;
};

async function createTempHome(): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), "openwiki-hubspot-"));
  tempHomes.push(home);
  return home;
}

function setConnectorTestHome(home: string): void {
  process.env.HOME = home;
  process.env.USERPROFILE = home;
}

async function loadHubSpotConnector(home: string) {
  vi.resetModules();
  setConnectorTestHome(home);
  const { createHubSpotConnector } =
    await import("../../../src/connectors/sources/hubspot.ts");
  return createHubSpotConnector();
}

function searchResponse(
  records: { id: string; properties?: Record<string, unknown> }[],
) {
  return jsonResponse({ results: records });
}

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
    delete process.env.HUBSPOT_TOKEN;
  } else {
    process.env.HUBSPOT_TOKEN = originalToken;
  }

  await Promise.all(
    tempHomes
      .splice(0)
      .map((home) => rm(home, { force: true, recursive: true })),
  );
});

describe("hubspot connector ingestion", () => {
  test("searches deals, companies, and contacts with a bearer token", async () => {
    process.env.HUBSPOT_TOKEN = "pat-eu1-test";
    const home = await createTempHome();
    const requests: {
      authorization: string | undefined;
      body: string;
      pathName: string;
    }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(
          input instanceof Request ? input.url : String(input),
        );
        requests.push({
          authorization:
            new Headers(init?.headers).get("Authorization") ?? undefined,
          body: typeof init?.body === "string" ? init.body : "",
          pathName: url.pathname,
        });
        if (url.pathname.endsWith("/deals/search")) {
          return Promise.resolve(
            searchResponse([
              {
                id: "501",
                properties: {
                  amount: "12000.0",
                  dealname: "Acme renewal",
                  dealstage: "contractsent",
                },
              },
            ]),
          );
        }
        if (url.pathname.endsWith("/companies/search")) {
          return Promise.resolve(
            searchResponse([
              { id: "801", properties: { domain: "acme.com", name: "Acme" } },
            ]),
          );
        }
        return Promise.resolve(searchResponse([]));
      }),
    );
    const connector = await loadHubSpotConnector(home);

    const result = await connector.ingest({ windowHours: 24 });

    expect(result.status).toBe("success");
    expect(result.warnings).toEqual([]);
    expect(requests).toHaveLength(3);
    expect(
      requests.every(
        (request) => request.authorization === "Bearer pat-eu1-test",
      ),
    ).toBe(true);

    const dealRequest = requests.find((request) =>
      request.pathName.endsWith("/deals/search"),
    );
    expect(dealRequest?.body).toContain('"hs_lastmodifieddate"');
    expect(dealRequest?.body).toContain('"GTE"');
    expect(dealRequest?.body).toContain('"dealname"');

    const dump = JSON.parse(
      await readFile(result.rawFiles[0] ?? "", "utf8"),
    ) as HubSpotDump;
    expect(dump.objects.deals).toEqual([
      {
        id: "501",
        properties: {
          amount: "12000.0",
          closedate: undefined,
          dealname: "Acme renewal",
          dealstage: "contractsent",
          hs_lastmodifieddate: undefined,
          pipeline: undefined,
        },
      },
    ]);
    // Contacts returned no results but must still be present as an empty list.
    expect(dump.objects.contacts).toEqual([]);
  });

  test("skips disabled object types without fetching them", async () => {
    process.env.HUBSPOT_TOKEN = "pat-eu1-test";
    const home = await createTempHome();
    const requestedPaths: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        requestedPaths.push(
          new URL(input instanceof Request ? input.url : String(input))
            .pathname,
        );
        return Promise.resolve(searchResponse([]));
      }),
    );
    const connector = await loadHubSpotConnector(home);

    const result = await connector.ingest({
      connectorConfig: { includeCompanies: false, includeContacts: false },
    });

    expect(result.status).toBe("success");
    expect(requestedPaths).toHaveLength(1);
    expect(requestedPaths[0]?.endsWith("/deals/search")).toBe(true);
  });
});

describe("hubspot connector gating and validation", () => {
  test("errors without fetching when HUBSPOT_TOKEN is missing", async () => {
    delete process.env.HUBSPOT_TOKEN;
    const home = await createTempHome();
    const fetchMock = vi.fn(() => {
      throw new Error("fetch should not be called");
    });
    vi.stubGlobal("fetch", fetchMock);
    const connector = await loadHubSpotConnector(home);

    const result = await connector.ingest();

    expect(result.status).toBe("error");
    expect(result.message).toContain("HUBSPOT_TOKEN");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("skips without fetching when disabled", async () => {
    const home = await createTempHome();
    const fetchMock = vi.fn(() => {
      throw new Error("fetch should not be called");
    });
    vi.stubGlobal("fetch", fetchMock);
    const connector = await loadHubSpotConnector(home);

    const result = await connector.ingest({
      connectorConfig: { enabled: false },
    });

    expect(result.status).toBe("skipped");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("downgrades one failing object type to a warning", async () => {
    process.env.HUBSPOT_TOKEN = "pat-eu1-test";
    const home = await createTempHome();
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = new URL(
          input instanceof Request ? input.url : String(input),
        );
        if (url.pathname.endsWith("/deals/search")) {
          return Promise.resolve(new Response("forbidden", { status: 403 }));
        }
        return Promise.resolve(searchResponse([]));
      }),
    );
    const connector = await loadHubSpotConnector(home);

    const result = await connector.ingest();

    expect(result.status).toBe("success");
    expect(
      result.warnings.some((warning) =>
        warning.startsWith("deals: HubSpot request failed: 403"),
      ),
    ).toBe(true);
  });
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
    status: 200,
  });
}

describe("hubspot connector delta sync", () => {
  test("bootstraps a window, then resumes from the stored high-water mark", async () => {
    process.env.HUBSPOT_TOKEN = "pat-eu1-test";
    const home = await createTempHome();
    const recent = new Date(Date.now() - 60 * 1000).toISOString();
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(
          input instanceof Request ? input.url : String(input),
        );
        requests.push(typeof init?.body === "string" ? init.body : "");
        if (url.pathname.endsWith("/deals/search")) {
          return Promise.resolve(
            searchResponse([
              {
                id: "502",
                properties: {
                  dealname: "Acme expansion",
                  hs_lastmodifieddate: recent,
                },
              },
            ]),
          );
        }
        return Promise.resolve(searchResponse([]));
      }),
    );
    const connector = await loadHubSpotConnector(home);

    // First run bootstraps from the connector default window.
    const bootstrap = await connector.ingest();
    expect(bootstrap.status).toBe("success");

    const state = JSON.parse(
      await readFile(
        path.join(home, ".openwiki/connectors/hubspot/state.json"),
        "utf8",
      ),
    ) as { latestIds: Record<string, string> };
    expect(state.latestIds.records).toBe(recent);

    // Second run resumes exactly from the stored high-water mark: every
    // request filters on hs_lastmodifieddate >= the stored cursor (ms epoch).
    requests.length = 0;
    await connector.ingest();
    expect(
      requests.every((body) => body.includes(String(Date.parse(recent)))),
    ).toBe(true);
  });
});
