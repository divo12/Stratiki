import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
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
import { syncDatasetView } from "../../../src/enrichment/views/lifecycle.ts";

const tempRoots: string[] = [];

interface Harness {
  cleanup(): Promise<void>;
  db: DatabaseSync;
  mappings: ViewMappingStore;
}

async function createHarness(): Promise<Harness> {
  const root = await mkdtemp(path.join(tmpdir(), "openwiki-crmmap-"));
  tempRoots.push(root);
  const dbPath = path.join(root, "book.db");
  const episodes = await EpisodeStore.open(dbPath);

  const admit = (
    connectorId: string,
    sourceRef: string,
    content: unknown,
    eventTimeIso: string,
  ): void => {
    const serialized = JSON.stringify(content);
    episodes.admit({
      bytes: Buffer.byteLength(serialized),
      connectorId,
      content: serialized,
      eventTimeIso,
      runId: "run-1",
      sourceRef,
    });
  };

  admit("stripe", "stripe-events.json#events#evt_9", {
    createdAt: "2026-08-20T10:00:00Z",
    customerEmail: "Dana@Acme.com",
    id: "evt_9",
    type: "invoice.paid",
  }, "2026-08-20T10:00:00Z");
  admit("zendesk", "tickets#11", {
    id: 11,
    status: "OPEN",
    updatedAt: "2026-08-21T09:00:00Z",
  }, "2026-08-21T09:00:00Z");
  admit("salesforce", "Account#001", {
    Email: "dana@acme.com",
    Id: "001",
    LastModifiedDate: "2026-08-19T08:00:00Z",
  }, "2026-08-19T08:00:00Z");
  admit("hubspot", "contacts#501", {
    id: 501,
    properties: { email: "dana@acme.com" },
  }, "2026-08-18T07:00:00Z");
  episodes.close();

  const db = new DatabaseSync(dbPath);
  const mappings = await ViewMappingStore.open(dbPath);

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
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("CRM dataset mappings", () => {
  test("project normalized, queryable columns for every CRM dataset", async () => {
    const harness = await createHarness();
    try {
      for (const set of [
        STRIPE_EVENTS_MAPPINGS,
        ZENDESK_TICKETS_MAPPINGS,
        SALESFORCE_RECORDS_MAPPINGS,
        HUBSPOT_RECORDS_MAPPINGS,
      ]) {
        harness.mappings.setMappings(set);
        syncDatasetView(harness.db, harness.mappings, set.datasetId);
      }

      const stripe = harness.db
        .prepare("SELECT event_id, event_type, customer_email FROM v_stripe_stripe_events")
        .get() as unknown as Record<string, string>;
      expect(stripe).toEqual({
        customer_email: "dana@acme.com",
        event_id: "evt_9",
        event_type: "invoice.paid",
      });

      const zendesk = harness.db
        .prepare("SELECT ticket_id, status FROM v_zendesk_zendesk_tickets")
        .get() as unknown as Record<string, unknown>;
      expect(zendesk).toEqual({ status: "open", ticket_id: 11 });

      const salesforce = harness.db
        .prepare("SELECT record_id, contact_email FROM v_salesforce_salesforce_records")
        .get() as unknown as Record<string, string>;
      expect(salesforce).toEqual({
        contact_email: "dana@acme.com",
        record_id: "001",
      });
    } finally {
      await harness.cleanup();
    }
  });

  test("v_customers unifies one email across sources by exact key", async () => {
    const harness = await createHarness();
    try {
      for (const set of [
        STRIPE_EVENTS_MAPPINGS,
        ZENDESK_TICKETS_MAPPINGS,
        SALESFORCE_RECORDS_MAPPINGS,
        HUBSPOT_RECORDS_MAPPINGS,
      ]) {
        harness.mappings.setMappings(set);
        syncDatasetView(harness.db, harness.mappings, set.datasetId);
      }
      harness.db.exec(emitCustomersView());

      const row = harness.db
        .prepare("SELECT customer_email, sources FROM v_customers")
        .get() as unknown as { customer_email: string; sources: string };
      expect(row.customer_email).toBe("dana@acme.com");
      expect(row.sources.split(",").sort()).toEqual([
        "hubspot",
        "salesforce",
        "stripe",
      ]);
    } finally {
      await harness.cleanup();
    }
  });
});
