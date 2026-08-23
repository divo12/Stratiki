import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalToken = process.env.STRIPE_SECRET_KEY;
const tempHomes: string[] = [];

async function createTempHome(): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), "openwiki-stripe-"));
  tempHomes.push(home);
  return home;
}

async function loadStripeConnector(home: string) {
  vi.resetModules();
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  const { createStripeConnector } =
    await import("../../../src/connectors/sources/stripe.ts");
  return createStripeConnector();
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

  const restore = (name: string, value: string | undefined): void => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  restore("HOME", originalHome);
  restore("USERPROFILE", originalUserProfile);
  restore("STRIPE_SECRET_KEY", originalToken);

  await Promise.all(
    tempHomes
      .splice(0)
      .map((home) => rm(home, { force: true, recursive: true })),
  );
});

describe("stripe connector ingestion", () => {
  test("lists recent events with bearer auth and writes a raw dump", async () => {
    process.env.STRIPE_SECRET_KEY = "rk-test";
    const home = await createTempHome();
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = new URL(
          input instanceof Request ? input.url : String(input),
        );
        requests.push(url.pathname + url.search);
        return Promise.resolve(
          jsonResponse({
            data: [
              {
                created: 1_700_000_000,
                id: "evt_1",
                livemode: false,
                type: "invoice.paid",
              },
            ],
            has_more: false,
          }),
        );
      }),
    );
    const connector = await loadStripeConnector(home);

    const result = await connector.ingest({ windowHours: 48 });

    expect(result.status).toBe("success");
    expect(result.warnings).toEqual([]);
    expect(requests[0]).toContain("/v1/events");
    expect(requests[0]).toContain("created%5Bgte%5D=");

    const dump = JSON.parse(
      await readFile(result.rawFiles[0] ?? "", "utf8"),
    ) as { events: { id: string; type: string }[] };
    expect(dump.events).toEqual([
      {
        createdAt: "2023-11-14T22:13:20.000Z",
        id: "evt_1",
        livemode: false,
        type: "invoice.paid",
      },
    ]);
    expect(result.message).toContain("1 Stripe event");
  });

  test("skips when not enabled and errors without credentials", async () => {
    const home = await createTempHome();
    const connector = await loadStripeConnector(home);

    const skipped = await connector.ingest({
      connectorConfig: { enabled: false },
    });
    expect(skipped.status).toBe("skipped");

    delete process.env.STRIPE_SECRET_KEY;
    const errored = await connector.ingest();
    expect(errored.status).toBe("error");
    expect(errored.message).toContain("STRIPE_SECRET_KEY");
  });
});
