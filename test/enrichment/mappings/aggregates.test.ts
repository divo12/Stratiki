import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { EpisodeStore } from "../../../src/book/episode-store.ts";
import { ViewMappingStore } from "../../../src/book/view-mappings.ts";
import {
  GOOGLE_ADS_MAPPINGS,
  META_ADS_MAPPINGS,
} from "../../../src/enrichment/mappings/aggregates.ts";
import { syncDatasetView } from "../../../src/enrichment/views/lifecycle.ts";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("aggregate dataset mappings", () => {
  test("project google-ads and meta-ads rows into queryable views", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "openwiki-aggmap-"));
    tempRoots.push(root);
    const dbPath = path.join(root, "book.db");
    const episodes = await EpisodeStore.open(dbPath);

    const adsRow = {
      campaignId: "111",
      clicks: 42,
      cost: 150,
      date: "2026-08-20",
      impressions: 1200,
    };
    const adsSerialized = JSON.stringify(adsRow);
    episodes.admit({
      bytes: Buffer.byteLength(adsSerialized),
      connectorId: "google-ads",
      content: adsSerialized,
      eventTimeIso: "2026-08-20T23:59:59Z",
      runId: "run-1",
      sourceRef: "google-ads-performance.json#111#2026-08-20",
    });
    episodes.close();

    const db = new DatabaseSync(dbPath);
    const mappings = await ViewMappingStore.open(dbPath);
    try {
      mappings.setMappings(GOOGLE_ADS_MAPPINGS);
      syncDatasetView(db, mappings, GOOGLE_ADS_MAPPINGS.datasetId);

      const row = db
        .prepare(
          "SELECT campaign_id, day, cost FROM v_google_ads_google_ads_performance",
        )
        .get() as unknown as Record<string, string | number>;
      expect(row).toEqual({ campaign_id: "111", cost: 150, day: "2026-08-20" });
    } finally {
      db.close();
      mappings.close();
    }
  });

  test("meta-ads mapping compiles and projects campaign ids", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "openwiki-metamap-"));
    tempRoots.push(root);
    const dbPath = path.join(root, "book.db");
    const episodes = await EpisodeStore.open(dbPath);

    const row = { campaignId: "234", clicks: 310, spend: 130.2 };
    const serialized = JSON.stringify(row);
    episodes.admit({
      bytes: Buffer.byteLength(serialized),
      connectorId: "meta-ads",
      content: serialized,
      eventTimeIso: "2026-08-22T00:00:00Z",
      runId: "run-1",
      sourceRef: "meta-insights.json#234",
    });
    episodes.close();

    const db = new DatabaseSync(dbPath);
    const mappings = await ViewMappingStore.open(dbPath);
    try {
      mappings.setMappings(META_ADS_MAPPINGS);
      syncDatasetView(db, mappings, META_ADS_MAPPINGS.datasetId);

      const projected = db
        .prepare("SELECT campaign_id, spend FROM v_meta_ads_meta_insights")
        .get() as unknown as Record<string, number>;
      expect(projected).toEqual({ campaign_id: "234", spend: 130.2 });
    } finally {
      db.close();
      mappings.close();
    }
  });
});
