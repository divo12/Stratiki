import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { ViewMappingStore } from "../../../src/book/view-mappings.ts";

const tempRoots: string[] = [];

async function createStore(): Promise<{
  store: ViewMappingStore;
  dbPath: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "openwiki-viewmap-"));
  tempRoots.push(root);
  const dbPath = path.join(root, "book.db");
  const store = await ViewMappingStore.open(dbPath);

  return { dbPath, store };
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("ViewMappingStore", () => {
  test("upserts, lists by dataset, and clears atomically", async () => {
    const { store } = await createStore();

    store.setMappings({
      columns: [
        { columnName: "event_id", jsonPath: "id", normalizer: "" },
        { columnName: "customer_email", jsonPath: "customer.email", normalizer: "text-casefold" },
      ],
      datasetId: "stripe/stripe-events",
      version: 1,
    });

    const loaded = store.getMappings("stripe/stripe-events");
    expect(loaded?.version).toBe(1);
    expect(loaded?.columns.map((column) => column.columnName)).toEqual([
      "event_id",
      "customer_email",
    ]);

    // Upsert replaces the full set: old columns disappear.
    store.setMappings({
      columns: [{ columnName: "event_id", jsonPath: "id", normalizer: "" }],
      datasetId: "stripe/stripe-events",
      version: 2,
    });
    expect(store.getMappings("stripe/stripe-events")?.columns).toHaveLength(1);
    expect(store.getMappings("stripe/stripe-events")?.version).toBe(2);

    store.clearDataset("stripe/stripe-events");
    expect(store.getMappings("stripe/stripe-events")).toBeNull();
  });

  test("survives a reopen against the same database file", async () => {
    const { dbPath, store } = await createStore();
    store.setMappings({
      columns: [{ columnName: "ticket_id", jsonPath: "id", normalizer: "" }],
      datasetId: "zendesk/zendesk-tickets",
      version: 3,
    });
    store.close();

    const reopened = await ViewMappingStore.open(dbPath);
    expect(reopened.getMappings("zendesk/zendesk-tickets")?.version).toBe(3);
    reopened.close();
  });

  test("lists datasets in sorted order", async () => {
    const { store } = await createStore();
    for (const datasetId of ["meta-ads/meta-insights", "stripe/stripe-events"]) {
      store.setMappings({
        columns: [{ columnName: "c", jsonPath: "x", normalizer: "" }],
        datasetId,
        version: 1,
      });
    }

    expect(store.listDatasets()).toEqual([
      "meta-ads/meta-insights",
      "stripe/stripe-events",
    ]);
  });
});
