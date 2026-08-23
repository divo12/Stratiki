import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

const savedEnv = new Map<string, string | undefined>(
  [
    "HOME",
    "USERPROFILE",
    "ZENDESK_EMAIL",
    "ZENDESK_API_TOKEN",
    "ZENDESK_SUBDOMAIN",
  ].map((name) => [name, process.env[name]]),
);
const tempHomes: string[] = [];

async function createTempHome(): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), "openwiki-zendesk-"));
  tempHomes.push(home);
  return home;
}

async function loadZendeskConnector(home: string) {
  vi.resetModules();
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  const { createZendeskConnector } =
    await import("../../../src/connectors/sources/zendesk.ts");
  return createZendeskConnector();
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

describe("zendesk connector ingestion", () => {
  test("reads incremental tickets with basic auth and trims fields", async () => {
    process.env.ZENDESK_EMAIL = "agent@acme.com";
    process.env.ZENDESK_API_TOKEN = "token-test";
    process.env.ZENDESK_SUBDOMAIN = "acme";
    const home = await createTempHome();
    const requests: { authorization: string | undefined; host: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(
          input instanceof Request ? input.url : String(input),
        );
        requests.push({
          authorization:
            new Headers(init?.headers).get("Authorization") ?? undefined,
          host: url.host,
        });
        return Promise.resolve(
          jsonResponse({
            end_of_stream: true,
            tickets: [
              {
                created_at: "2026-08-20T10:00:00Z",
                description: "Cannot sign in",
                id: 42,
                priority: "high",
                status: "open",
                subject: "Login broken",
                updated_at: "2026-08-21T09:00:00Z",
                url: "https://acme.zendesk.com/api/v2/tickets/42.json",
              },
            ],
          }),
        );
      }),
    );
    const connector = await loadZendeskConnector(home);

    const result = await connector.ingest({ windowHours: 24 });

    expect(result.status).toBe("success");
    expect(requests[0]?.host).toBe("acme.zendesk.com");
    expect(requests[0]?.authorization).toBe(
      `Basic ${Buffer.from("agent@acme.com/token:token-test").toString("base64")}`,
    );

    const dump = JSON.parse(
      await readFile(result.rawFiles[0] ?? "", "utf8"),
    ) as { tickets: Record<string, unknown>[] };
    expect(dump.tickets).toEqual([
      {
        createdAt: "2026-08-20T10:00:00Z",
        description: "Cannot sign in",
        id: 42,
        priority: "high",
        status: "open",
        subject: "Login broken",
        updatedAt: "2026-08-21T09:00:00Z",
      },
    ]);

    // The next run resumes from the stored incremental end time.
    const state = JSON.parse(
      await readFile(
        path.join(home, ".openwiki/connectors/zendesk/state.json"),
        "utf8",
      ),
    ) as { latestIds: Record<string, string> };
    expect(Number.parseInt(state.latestIds.tickets, 10)).toBeGreaterThan(0);
  });

  test("skips when not enabled and errors without credentials", async () => {
    const home = await createTempHome();
    const connector = await loadZendeskConnector(home);

    const skipped = await connector.ingest({
      connectorConfig: { enabled: false },
    });
    expect(skipped.status).toBe("skipped");

    delete process.env.ZENDESK_API_TOKEN;
    const errored = await connector.ingest();
    expect(errored.status).toBe("error");
    expect(errored.message).toContain("ZENDESK_");
  });
});
