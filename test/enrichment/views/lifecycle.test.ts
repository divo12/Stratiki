import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { EpisodeStore } from "../../../src/book/episode-store.ts";
import {
  ViewMappingStore,
  type ViewMappingSet,
} from "../../../src/book/view-mappings.ts";
import {
  syncAllViews,
  syncDatasetView,
} from "../../../src/enrichment/views/lifecycle.ts";

const tempRoots: string[] = [];

interface TestHarness {
  cleanup(): Promise<void>;
  db: DatabaseSync;
  mappings: ViewMappingStore;
}

async function createHarness(): Promise<TestHarness> {
  const root = await mkdtemp(path.join(tmpdir(), "openwiki-lifecycle-"));
  tempRoots.push(root);
  const dbPath = path.join(root, "book.db");
  const episodes = await EpisodeStore.open(dbPath);
  episodes.admit({
    bytes: Buffer.byteLength(JSON.stringify({ id: "evt_1" })),
    connectorId: "stripe",
    content: JSON.stringify({ customerEmail: "a@acme.com", id: "evt_1" }),
    eventTimeIso: "2026-08-20T10:00:00Z",
    runId: "run-1",
    sourceRef: "stripe-events.json#events#evt_1",
  });
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

function stripeMappings(version: number): ViewMappingSet {
  return {
    columns: [
      { columnName: "customer_email", jsonPath: "customerEmail", normalizer: "text-casefold" },
      { columnName: "event_id", jsonPath: "id", normalizer: "" },
    ],
    datasetId: "stripe/stripe-events",
    version,
  };
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("view lifecycle", () => {
  test("creates once, reports unchanged on resync, replaces on drift", async () => {
    const harness = await createHarness();
    try {
      harness.mappings.setMappings(stripeMappings(1));

      expect(runSync(harness)).toEqual({
        action: "created",
        viewName: "v_stripe_stripe_events",
      });
      expect(runSync(harness)).toEqual({
        action: "unchanged",
        viewName: "v_stripe_stripe_events",
      });

      harness.mappings.setMappings({
        columns: [
          ...stripeMappings(2).columns,
          { columnName: "amount", jsonPath: "amount", normalizer: "" },
        ],
        datasetId: "stripe/stripe-events",
        version: 2,
      });
      expect(runSync(harness)).toEqual({
        action: "replaced",
        viewName: "v_stripe_stripe_events",
      });
    } finally {
      await harness.cleanup();
    }
  });

  test("querying the view applies the registered normalizer", async () => {
    const harness = await createHarness();
    try {
      harness.mappings.setMappings(stripeMappings(1));
      runSync(harness);

      const row = harness.db
        .prepare("SELECT customer_email, event_id FROM v_stripe_stripe_events")
        .get() as unknown as { customer_email: string; event_id: string };

      expect(row).toEqual({ customer_email: "a@acme.com", event_id: "evt_1" });
    } finally {
      await harness.cleanup();
    }
  });

  test("drops stale views when their dataset loses its mappings", async () => {
    const harness = await createHarness();
    try {
      harness.mappings.setMappings(stripeMappings(1));
      runSync(harness);

      harness.mappings.clearDataset("stripe/stripe-events");
      const outcomes = syncAllViews(harness.db, harness.mappings);

      expect(outcomes).toContainEqual({
        action: "dropped",
        viewName: "v_stripe_stripe_events",
      });
      const remaining = harness.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'view' AND name = 'v_stripe_stripe_events'",
        )
        .all();
      expect(remaining).toHaveLength(0);
    } finally {
      await harness.cleanup();
    }
  });
});

function runSync(harness: TestHarness): ReturnType<typeof syncDatasetView> {
  return syncDatasetView(harness.db, harness.mappings, "stripe/stripe-events");
}
