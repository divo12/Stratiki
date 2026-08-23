import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { EpisodeStore } from "../../src/book/episode-store.ts";

const temporaryRoots: string[] = [];

async function createStore(): Promise<EpisodeStore> {
  const root = await mkdtemp(path.join(tmpdir(), "openwiki-catalog-"));
  temporaryRoots.push(root);
  return await EpisodeStore.open(path.join(root, "book.db"));
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("dataset catalog", () => {
  test("registers datasets and upserts observations", async () => {
    const store = await createStore();

    store.observeDataset({
      datasetId: "stripe/stripe-events",
      observedAtIso: "2026-08-22T10:00:00Z",
      partitionRoot: "connectors/stripe/raw",
      sampleRecord: '{"id":"evt_1"}',
      schemaVersion: 1,
    });
    store.observeDataset({
      datasetId: "zendesk/zendesk-tickets",
      observedAtIso: "2026-08-22T10:05:00Z",
      partitionRoot: "connectors/zendesk/raw",
      sampleRecord: '{"id":42}',
      schemaVersion: 1,
    });

    // A later observation refreshes the sample and stamps, keeping the
    // original first-seen time.
    store.observeDataset({
      datasetId: "stripe/stripe-events",
      observedAtIso: "2026-08-23T09:00:00Z",
      partitionRoot: "connectors/stripe/raw",
      sampleRecord: '{"id":"evt_2","type":"invoice.paid"}',
      schemaVersion: 2,
    });

    expect(store.listDatasets()).toEqual([
      {
        datasetId: "stripe/stripe-events",
        firstSeenAt: "2026-08-22T10:00:00Z",
        lastSeenAt: "2026-08-23T09:00:00Z",
        partitionRoot: "connectors/stripe/raw",
        sampleRecord: '{"id":"evt_2","type":"invoice.paid"}',
        schemaVersion: 2,
      },
      {
        datasetId: "zendesk/zendesk-tickets",
        firstSeenAt: "2026-08-22T10:05:00Z",
        lastSeenAt: "2026-08-22T10:05:00Z",
        partitionRoot: "connectors/zendesk/raw",
        sampleRecord: '{"id":42}',
        schemaVersion: 1,
      },
    ]);

    store.close();
  });

  test("starts empty on a fresh store", async () => {
    const store = await createStore();

    expect(store.listDatasets()).toEqual([]);

    store.close();
  });
});
