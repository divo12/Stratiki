import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

const savedEnv = new Map<string, string | undefined>(
  ["HOME", "USERPROFILE", "META_ACCESS_TOKEN", "META_AD_ACCOUNT_ID"].map(
    (name) => [name, process.env[name]],
  ),
);
const tempHomes: string[] = [];

async function createTempHome(): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), "openwiki-meta-ads-"));
  tempHomes.push(home);
  return home;
}

async function loadConnector(home: string) {
  vi.resetModules();
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  const { createMetaAdsConnector } =
    await import("../../../src/connectors/sources/meta-ads.ts");
  return createMetaAdsConnector();
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

describe("meta-ads connector ingestion", () => {
  test("fetches campaign insights with bearer auth and numeric coercion", async () => {
    process.env.META_ACCESS_TOKEN = "EAAG-test";
    process.env.META_AD_ACCOUNT_ID = "1029384756";
    const home = await createTempHome();
    const requests: { authorization: string | undefined; pathName: string }[] =
      [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(
          input instanceof Request ? input.url : String(input),
        );
        requests.push({
          authorization:
            new Headers(init?.headers).get("Authorization") ?? undefined,
          pathName: url.pathname,
        });
        return Promise.resolve(
          jsonResponse({
            data: [
              {
                campaign_id: "234",
                campaign_name: "Spring launch",
                clicks: "310",
                cpc: "0.42",
                cpm: "5.10",
                spend: "130.20",
              },
            ],
          }),
        );
      }),
    );
    const connector = await loadConnector(home);

    const result = await connector.ingest();

    expect(result.status).toBe("success");
    expect(requests[0]?.pathName).toBe("/v21.0/act_1029384756/insights");
    expect(requests[0]?.authorization).toBe("Bearer EAAG-test");
    expect(result.message).toContain("last_7d");

    const dump = JSON.parse(
      await readFile(result.rawFiles[0] ?? "", "utf8"),
    ) as {
      rows: { clicks: number; spend: number }[];
    };
    expect(dump.rows[0]?.clicks).toBe(310);
    expect(dump.rows[0]?.spend).toBeCloseTo(130.2);
  });

  test("skips when not enabled and errors without credentials", async () => {
    const home = await createTempHome();
    const connector = await loadConnector(home);

    const skipped = await connector.ingest({
      connectorConfig: { enabled: false },
    });
    expect(skipped.status).toBe("skipped");

    delete process.env.META_AD_ACCOUNT_ID;
    const errored = await connector.ingest();
    expect(errored.status).toBe("error");
    expect(errored.message).toContain("META_AD_ACCOUNT_ID");
  });
});
