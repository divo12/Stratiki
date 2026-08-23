import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

const savedEnv = new Map<string, string | undefined>(
  [
    "HOME",
    "USERPROFILE",
    "GA4_PROPERTY_ID",
    "GOOGLE_ANALYTICS_ACCESS_TOKEN",
  ].map((name) => [name, process.env[name]]),
);
const tempHomes: string[] = [];

async function createTempHome(): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), "openwiki-ga4-"));
  tempHomes.push(home);
  return home;
}

async function loadConnector(home: string) {
  vi.resetModules();
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  const { createGoogleAnalyticsConnector } =
    await import("../../../src/connectors/sources/google-analytics.ts");
  return createGoogleAnalyticsConnector();
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

describe("google-analytics connector ingestion", () => {
  test("runs a GA4 report with bearer auth and writes a raw dump", async () => {
    process.env.GA4_PROPERTY_ID = "123456789";
    process.env.GOOGLE_ANALYTICS_ACCESS_TOKEN = "ya29-test";
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
        return Promise.resolve(
          jsonResponse({
            rowCount: 1,
            rows: [
              {
                dimensionValues: [
                  { value: "20260820" },
                  { value: "Organic Search" },
                ],
                metricValues: [
                  { value: "120" },
                  { value: "140" },
                  { value: "310" },
                ],
              },
            ],
          }),
        );
      }),
    );
    const connector = await loadConnector(home);

    const result = await connector.ingest({ windowHours: 24 * 7 });

    expect(result.status).toBe("success");
    expect(requests[0]?.pathName).toBe(
      "/v1beta/properties/123456789:runReport",
    );
    expect(requests[0]?.authorization).toBe("Bearer ya29-test");
    expect(requests[0]?.body).toContain('"dateRanges"');
    expect(requests[0]?.body).toContain('"activeUsers"');

    const dump = JSON.parse(
      await readFile(result.rawFiles[0] ?? "", "utf8"),
    ) as {
      rowCount: number;
    };
    expect(dump.rowCount).toBe(1);
    expect(result.message).toContain("1 GA4 report row");
  });

  test("skips when not enabled and errors without credentials", async () => {
    const home = await createTempHome();
    const connector = await loadConnector(home);

    const skipped = await connector.ingest({
      connectorConfig: { enabled: false },
    });
    expect(skipped.status).toBe("skipped");

    delete process.env.GA4_PROPERTY_ID;
    const errored = await connector.ingest();
    expect(errored.status).toBe("error");
    expect(errored.message).toContain("GA4_PROPERTY_ID");
  });
});
