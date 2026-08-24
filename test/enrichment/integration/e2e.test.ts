import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { EpisodeStore } from "../../../src/book/episode-store.ts";
import { ViewMappingStore } from "../../../src/book/view-mappings.ts";
import { STRIPE_EVENTS_MAPPINGS } from "../../../src/enrichment/mappings/crm.ts";
import {
  syncAllViews,
  syncDatasetView,
} from "../../../src/enrichment/views/lifecycle.ts";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("end-to-end ingest → admit → query", () => {
  test("admitted episodes become normalized view rows and dedupe on replay", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "openwiki-e2e-"));
    tempRoots.push(root);
    const dbPath = path.join(root, "book.db");
    const episodes = await EpisodeStore.open(dbPath);

    const record = {
      createdAt: "2026-08-20T10:00:00Z",
      customerEmail: "Dana@Acme.com",
      id: "evt_e2e",
      type: "invoice.paid",
    };
    const serialized = JSON.stringify(record);
    const admission = {
      bytes: Buffer.byteLength(serialized),
      connectorId: "stripe",
      content: serialized,
      eventTimeIso: record.createdAt,
      runId: "",
      sourceRef: "stripe-events.json#events#evt_e2e",
    };

    // Two identical admissions (simulating a delta-sync replay) must land as
    // one episode.
    episodes.admit({ ...admission, runId: "run-1" });
    const second = episodes.admit({ ...admission, runId: "run-2" });
    expect(second.outcome).toBe("duplicate");
    episodes.close();

    const mappings = await ViewMappingStore.open(dbPath);
    mappings.setMappings(STRIPE_EVENTS_MAPPINGS);
    const db = new DatabaseSync(dbPath);
    try {
      expect(syncAllViews(db, mappings)).toContainEqual({
        action: "created",
        viewName: "v_stripe_stripe_events",
      });
      expect(syncDatasetView(db, mappings, "stripe/stripe-events").action).toBe(
        "unchanged",
      );

      const row = db
        .prepare(
          "SELECT event_id, customer_email, created_at FROM v_stripe_stripe_events ORDER BY created_at",
        )
        .all() as unknown as Record<string, string>[];
      expect(row).toEqual([
        {
          created_at: "2026-08-20T10:00:00Z",
          customer_email: "dana@acme.com",
          event_id: "evt_e2e",
        },
      ]);
    } finally {
      db.close();
    }
  });
});
