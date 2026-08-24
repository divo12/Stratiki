import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { EpisodeStore } from "../../../src/book/episode-store.ts";
import { ViewMappingStore } from "../../../src/book/view-mappings.ts";
import {
  HUBSPOT_RECORDS_MAPPINGS,
  SALESFORCE_RECORDS_MAPPINGS,
  STRIPE_EVENTS_MAPPINGS,
  ZENDESK_TICKETS_MAPPINGS,
} from "../../../src/enrichment/mappings/crm.ts";
import {
  emitCustomersView,
} from "../../../src/enrichment/mappings/customers.ts";
import { syncAllViews } from "../../../src/enrichment/views/lifecycle.ts";

const tempRoots: string[] = [];

interface Harness {
  cleanup(): Promise<void>;
  db: DatabaseSync;
  mappings: ViewMappingStore;
}

async function createHarness(): Promise<Harness> {
  const root = await mkdtemp(path.join(tmpdir(), "openwiki-customers-"));
  tempRoots.push(root);
  const dbPath = path.join(root, "book.db");
  const episodes = await EpisodeStore.open(dbPath);

  const admit = (
    connectorId: string,
    sourceRef: string,
    content: unknown,
  ): void => {
    const serialized = JSON.stringify(content);
    episodes.admit({
      bytes: Buffer.byteLength(serialized),
      connectorId,
      content: serialized,
      eventTimeIso: "2026-08-20T10:00:00Z",
      runId: "run-1",
      sourceRef,
    });
  };

  admit("stripe", "stripe-events.json#events#evt_1", {
    createdAt: "2026-08-20T10:00:00Z",
    customerEmail: "dana@acme.com",
    id: "evt_1",
    type: "invoice.paid",
  });
  admit("zendesk", "tickets#11", {
    id: 11,
    requesterEmail: "Dana@Acme.com",
    status: "open",
    updatedAt: "2026-08-21T09:00:00Z",
  });
  admit("salesforce", "Contact#001", {
    Email: "dana@acme.com",
    Id: "001",
    LastModifiedDate: "2026-08-19T08:00:00Z",
  });
  admit("stripe", "stripe-events.json#events#evt_2", {
    createdAt: "2026-08-20T11:00:00Z",
    customerEmail: "other@beta.io",
    id: "evt_2",
    type: "charge.refunded",
  });
  episodes.close();

  const db = new DatabaseSync(dbPath);
  const mappings = await ViewMappingStore.open(dbPath);
  for (const set of [
    STRIPE_EVENTS_MAPPINGS,
    ZENDESK_TICKETS_MAPPINGS,
    SALESFORCE_RECORDS_MAPPINGS,
    HUBSPOT_RECORDS_MAPPINGS,
  ]) {
    mappings.setMappings(set);
  }
  syncAllViews(db, mappings);
  db.exec(emitCustomersView());

  return {
    cleanup: async () => {
      db.close();
      mappings.close();
      await rm(root, { force: true, recursive: true });
    },
    db,
    mappings,
  };
}

afterEach(async () => {
  vi.resetModules();
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("v_customers cross-dataset view", () => {
  test("unifies one case-varied email across three sources", async () => {
    const harness = await createHarness();

    const row = harness.db
      .prepare("SELECT customer_email, sources FROM v_customers WHERE customer_email = 'dana@acme.com'")
      .get() as unknown as { customer_email: string; sources: string };

    expect(row.sources.split(",").sort()).toEqual([
      "salesforce",
      "stripe",
      "zendesk",
    ]);
  });

  test("keeps disjoint emails as separate entities", async () => {
    const harness = await createHarness();

    const rows = harness.db
      .prepare("SELECT customer_email FROM v_customers ORDER BY customer_email")
      .all() as unknown as { customer_email: string }[];

    expect(rows.map((row) => row.customer_email)).toEqual([
      "dana@acme.com",
      "other@beta.io",
    ]);
  });
});
