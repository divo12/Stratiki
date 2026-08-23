import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { EpisodeStore } from "../../src/book/episode-store.js";

const tempDirs: string[] = [];

async function createStore(): Promise<{ store: EpisodeStore; dbPath: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "stratiki-episodes-"));
  tempDirs.push(dir);
  const dbPath = path.join(dir, "book.db");
  return { dbPath, store: await EpisodeStore.open(dbPath) };
}

function admission(overrides?: Partial<Parameters<EpisodeStore["admit"]>[0]>) {
  return {
    bytes: 10,
    connectorId: "github",
    content: JSON.stringify({ ok: true }),
    eventTimeIso: "2026-08-22T00:00:00.000Z",
    runId: "run-1",
    sourceRef: "/raw/github/run-1/github-results.json",
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })),
  );
});

describe("EpisodeStore.admit", () => {
  test("admits a fresh episode with bi-temporal timestamps", async () => {
    const { store } = await createStore();

    const result = store.admit(admission());

    expect(result.outcome).toBe("admitted");
    if (result.outcome !== "admitted" && result.outcome !== "duplicate") {
      expect.unreachable();
    }
    expect(result.episode.eventTimeIso).toBe("2026-08-22T00:00:00.000Z");
    // Ingest time is stamped by the store, not trusted from the caller.
    expect(result.episode.ingestTimeIso >= result.episode.eventTimeIso).toBe(
      true,
    );
    expect(result.episode.contentHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(store.count()).toBe(1);
  });

  test("reports duplicates without writing when the same artifact re-pulls", async () => {
    const { store } = await createStore();

    const first = store.admit(admission());
    const second = store.admit(
      admission({ runId: "run-2", eventTimeIso: "2026-08-23T00:00:00.000Z" }),
    );

    expect(first.outcome).toBe("admitted");
    expect(second.outcome).toBe("duplicate");
    if (second.outcome === "admitted" || second.outcome === "rejected") {
      expect.unreachable();
    }
    // The stored record keeps the FIRST ingest time; history is not rewritten.
    expect(second.episode.id).toBe(
      first.outcome === "rejected" ? -1 : first.episode.id,
    );
    expect(store.count()).toBe(1);
  });

  test("same content under a different sourceRef admits separately", async () => {
    const { store } = await createStore();

    store.admit(admission());
    const other = store.admit(admission({ sourceRef: "/raw/other.json" }));

    expect(other.outcome).toBe("admitted");
    expect(store.count()).toBe(2);
  });
});

describe("EpisodeStore admission policy", () => {
  // Assembled at runtime so secret scanners do not see a literal credential.
  const FAKE_GITHUB_TOKEN = `ghp_${"A".repeat(24)}1234`;

  test("rejects credential-shaped payloads fail-closed", async () => {
    const { store } = await createStore();

    const result = store.admit(
      admission({
        content: JSON.stringify({ token: FAKE_GITHUB_TOKEN }),
      }),
    );

    expect(result.outcome).toBe("rejected");
    if (result.outcome !== "rejected") {
      expect.unreachable();
    }
    expect(result.decision.rejection.reason).toContain("github-token");
    expect(store.count()).toBe(0);
  });

  test("rejects oversized and non-JSON payloads", async () => {
    const { store } = await createStore();

    const oversize = store.admit(
      admission({ bytes: 11 * 1024 * 1024, content: "{}" }),
    );
    const nonJson = store.admit(admission({ content: "<html>nope</html>" }));

    expect(oversize.outcome).toBe("rejected");
    expect(nonJson.outcome === "rejected").toBe(true);
    expect(store.count()).toBe(0);
  });
});

describe("EpisodeStore persistence", () => {
  test("rows survive close and reopen", async () => {
    const { dbPath, store } = await createStore();
    store.admit(admission());
    store.close();

    const reopened = await EpisodeStore.open(dbPath);
    try {
      expect(reopened.count()).toBe(1);
      const [recent] = reopened.listRecent(10);
      expect(recent?.connectorId).toBe("github");
    } finally {
      reopened.close();
    }
  });

  test("listRecent returns newest-ingested first", async () => {
    const { store } = await createStore();
    store.admit(
      admission({
        sourceRef: "/raw/first.json",
        eventTimeIso: "2026-08-20T00:00:00.000Z",
      }),
    );
    store.admit(admission({ sourceRef: "/raw/second.json" }));

    const recent = store.listRecent(10);

    expect(recent.map((episode) => episode.sourceRef)).toEqual([
      "/raw/second.json",
      "/raw/first.json",
    ]);
  });
});
