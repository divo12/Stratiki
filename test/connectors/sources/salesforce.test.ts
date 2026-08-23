import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

const savedEnv = new Map<string, string | undefined>(
  [
    "HOME",
    "USERPROFILE",
    "SALESFORCE_ACCESS_TOKEN",
    "SALESFORCE_INSTANCE_URL",
  ].map((name) => [name, process.env[name]]),
);
// Recent enough to fall inside any lookback window the test uses.
const RECENT_MODIFIED = new Date(Date.now() - 60 * 1000).toISOString();
const tempHomes: string[] = [];

async function createTempHome(): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), "openwiki-salesforce-"));
  tempHomes.push(home);
  return home;
}

async function loadSalesforceConnector(home: string) {
  vi.resetModules();
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  const { createSalesforceConnector } =
    await import("../../../src/connectors/sources/salesforce.ts");
  return createSalesforceConnector();
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status: 200,
  });
}

afterEach(async () => {
  vi.resetModules();
  vi.unstubAllGlobals();

  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }

  await Promise.all(
    tempHomes
      .splice(0)
      .map((home) => rm(home, { force: true, recursive: true })),
  );
});

describe("salesforce connector ingestion", () => {
  test("runs SOQL per object type with bearer auth and writes a raw dump", async () => {
    process.env.SALESFORCE_ACCESS_TOKEN = "00D-test";
    process.env.SALESFORCE_INSTANCE_URL = "https://acme.my.salesforce.com";
    const home = await createTempHome();
    const queries: { authorization: string | undefined; q: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(
          input instanceof Request ? input.url : String(input),
        );
        queries.push({
          authorization:
            new Headers(init?.headers).get("Authorization") ?? undefined,
          q: url.searchParams.get("q") ?? "",
        });
        return Promise.resolve(
          jsonResponse({
            done: true,
            records: [
              {
                Id: "001",
                LastModifiedDate: RECENT_MODIFIED,
                Name: "Acme",
                attributes: { type: "Account" },
              },
            ],
          }),
        );
      }),
    );
    const connector = await loadSalesforceConnector(home);

    const result = await connector.ingest({ windowHours: 24 });

    expect(result.status).toBe("success");
    expect(queries).toHaveLength(4);
    expect(queries[0]?.authorization).toBe("Bearer 00D-test");
    expect(queries[0]?.q).toContain("FROM Account");
    expect(
      queries.every((query) => query.q.includes("LastModifiedDate >=")),
    ).toBe(true);

    const dump = JSON.parse(
      await readFile(result.rawFiles[0] ?? "", "utf8"),
    ) as { records: Record<string, Record<string, unknown>[]> };
    expect(dump.records.Account).toEqual([
      {
        Id: "001",
        LastModifiedDate: RECENT_MODIFIED,
        Name: "Acme",
      },
    ]);

    // The cursor advances to the newest LastModifiedDate actually returned,
    // not the query's lower bound.
    const state = JSON.parse(
      await readFile(
        path.join(home, ".openwiki/connectors/salesforce/state.json"),
        "utf8",
      ),
    ) as { latestIds: Record<string, string> };
    expect(state.latestIds.records).toBe(RECENT_MODIFIED);

    queries.length = 0;
    await connector.ingest();
    expect(queries[0]?.q).toContain(
      `LastModifiedDate >= ${state.latestIds.records}`,
    );
  });

  test("skips when not enabled and errors without credentials", async () => {
    const home = await createTempHome();
    const connector = await loadSalesforceConnector(home);

    const skipped = await connector.ingest({
      connectorConfig: { enabled: false },
    });
    expect(skipped.status).toBe("skipped");

    delete process.env.SALESFORCE_ACCESS_TOKEN;
    delete process.env.SALESFORCE_INSTANCE_URL;
    const errored = await connector.ingest();
    expect(errored.status).toBe("error");
    expect(errored.message).toContain("SALESFORCE_ACCESS_TOKEN");
  });
});
