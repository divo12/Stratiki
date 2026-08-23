import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

const savedEnv = new Map<string, string | undefined>(
  [
    "HOME",
    "USERPROFILE",
    "GOOGLE_ADS_ACCESS_TOKEN",
    "GOOGLE_ADS_CUSTOMER_ID",
    "GOOGLE_ADS_DEVELOPER_TOKEN",
  ].map((name) => [name, process.env[name]]),
);
const tempHomes: string[] = [];

async function createTempHome(): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), "openwiki-google-ads-"));
  tempHomes.push(home);
  return home;
}

async function loadConnector(home: string) {
  vi.resetModules();
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  const { createGoogleAdsConnector } =
    await import("../../../src/connectors/sources/google-ads.ts");
  return createGoogleAdsConnector();
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

describe("google-ads connector ingestion", () => {
  test("runs a search stream query with developer token and converts micros", async () => {
    process.env.GOOGLE_ADS_ACCESS_TOKEN = "ya29-ads";
    process.env.GOOGLE_ADS_CUSTOMER_ID = "1234567890";
    process.env.GOOGLE_ADS_DEVELOPER_TOKEN = "dev-token";
    const home = await createTempHome();
    const requests: {
      authorization: string | undefined;
      body: string;
      developerToken: string | undefined;
      pathName: string;
    }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(
          input instanceof Request ? input.url : String(input),
        );
        const headers = new Headers(init?.headers);
        requests.push({
          authorization: headers.get("Authorization") ?? undefined,
          body: typeof init?.body === "string" ? init.body : "",
          developerToken: headers.get("developer-token") ?? undefined,
          pathName: url.pathname,
        });
        return Promise.resolve(
          jsonResponse([
            {
              results: [
                {
                  campaign: { id: "111", name: "Brand", status: "ENABLED" },
                  metrics: {
                    clicks: "42",
                    conversions: "3.0",
                    costMicros: "150000000",
                    impressions: "1200",
                  },
                  segments: { date: "2026-08-20" },
                },
              ],
            },
          ]),
        );
      }),
    );
    const connector = await loadConnector(home);

    const result = await connector.ingest({ windowHours: 24 * 7 });

    expect(result.status).toBe("success");
    expect(requests[0]?.pathName).toContain(
      "/customers/1234567890/googleAds:searchStream",
    );
    expect(requests[0]?.developerToken).toBe("dev-token");
    expect(requests[0]?.authorization).toBe("Bearer ya29-ads");
    expect(requests[0]?.body).toContain("FROM campaign");

    const dump = JSON.parse(
      await readFile(result.rawFiles[0] ?? "", "utf8"),
    ) as {
      rows: { cost: number; date: string | undefined }[];
    };
    expect(dump.rows[0]?.cost).toBeCloseTo(150);
    expect(dump.rows[0]?.date).toBe("2026-08-20");
  });

  test("skips when not enabled and errors without credentials", async () => {
    const home = await createTempHome();
    const connector = await loadConnector(home);

    const skipped = await connector.ingest({
      connectorConfig: { enabled: false },
    });
    expect(skipped.status).toBe("skipped");

    delete process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
    const errored = await connector.ingest();
    expect(errored.status).toBe("error");
    expect(errored.message).toContain("GOOGLE_ADS_DEVELOPER_TOKEN");
  });
});
