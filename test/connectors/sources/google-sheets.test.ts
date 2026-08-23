import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

const savedEnv = new Map<string, string | undefined>(
  ["HOME", "USERPROFILE", "GOOGLE_SHEETS_ACCESS_TOKEN"].map((name) => [
    name,
    process.env[name],
  ]),
);
const tempHomes: string[] = [];

async function createTempHome(): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), "openwiki-sheets-"));
  tempHomes.push(home);
  return home;
}

async function loadConnector(home: string) {
  vi.resetModules();
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  const { createGoogleSheetsConnector } =
    await import("../../../src/connectors/sources/google-sheets.ts");
  return createGoogleSheetsConnector();
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

describe("google-sheets connector ingestion", () => {
  test("reads configured ranges with bearer auth and string cells", async () => {
    process.env.GOOGLE_SHEETS_ACCESS_TOKEN = "ya29-sheets";
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
            majorDimension: "ROWS",
            values: [
              ["goal", "owner"],
              ["ship connectors", "me"],
            ],
          }),
        );
      }),
    );
    const connector = await loadConnector(home);

    const result = await connector.ingest({
      connectorConfig: {
        spreadsheets: [{ range: "Goals!A1:B10", spreadsheetId: "sheet-1" }],
      },
    });

    expect(result.status).toBe("success");
    expect(requests[0]?.pathName).toContain("/v4/spreadsheets/sheet-1/values/");
    expect(requests[0]?.authorization).toBe("Bearer ya29-sheets");

    const dump = JSON.parse(
      await readFile(result.rawFiles[0] ?? "", "utf8"),
    ) as {
      exports: { rows: string[][]; spreadsheetId: string }[];
    };
    expect(dump.exports[0]?.spreadsheetId).toBe("sheet-1");
    expect(dump.exports[0]?.rows[1]).toEqual(["ship connectors", "me"]);
  });

  test("skips when not enabled and when no sheets are configured", async () => {
    const home = await createTempHome();
    process.env.GOOGLE_SHEETS_ACCESS_TOKEN = "ya29-sheets";
    const connector = await loadConnector(home);

    const skippedDisabled = await connector.ingest({
      connectorConfig: { enabled: false },
    });
    expect(skippedDisabled.status).toBe("skipped");

    const skippedEmpty = await connector.ingest();
    expect(skippedEmpty.status).toBe("skipped");
    expect(skippedEmpty.message).toContain("No sheets configured");

    delete process.env.GOOGLE_SHEETS_ACCESS_TOKEN;
    const errored = await connector.ingest({
      connectorConfig: {
        spreadsheets: [{ range: "A1", spreadsheetId: "s" }],
      },
    });
    expect(errored.status).toBe("error");
    expect(errored.message).toContain("GOOGLE_SHEETS_ACCESS_TOKEN");
  });
});
