import { describe, expect, test } from "vitest";
import type { EpisodeRecord } from "../../src/book/episode-store.js";
import { planRefresh } from "../../src/book/refresh-planner.js";

const NOW = new Date("2026-08-22T12:00:00.000Z");

function episode(ingestTimeIso: string, connectorId = "github"): EpisodeRecord {
  return {
    bytes: 10,
    connectorId,
    contentHash: "abc",
    eventTimeIso: ingestTimeIso,
    id: 1,
    ingestTimeIso,
    runId: "r",
    sourceRef: "/raw/x.json",
  };
}

describe("planRefresh", () => {
  test("sources with no episodes are always due", () => {
    const { due, deferred } = planRefresh({ slack: "daily" }, new Map(), NOW);

    expect(due).toHaveLength(1);
    expect(deferred).toEqual([]);
    expect(due[0]?.entry.reason).toBe("never-pulled");
    expect(due[0]?.entry.connectorId).toBe("slack");
  });

  test("hot sources go stale within an hour; weekly sources stay deferred", () => {
    // 61 minutes old: past the hot window.
    const hotOldIngest = new Date(NOW.getTime() - 61 * 60 * 1000).toISOString();
    const recentIngest = new Date(NOW.getTime() - 30 * 60 * 1000).toISOString();
    const { due, deferred } = planRefresh(
      { github: "hot", linear: "weekly" },
      new Map([
        ["github", episode(hotOldIngest, "github")],
        ["linear", episode(recentIngest, "linear")],
      ]),
      NOW,
    );

    expect(due.map((decision) => decision.entry.connectorId)).toEqual([
      "github",
    ]);
    expect(deferred.map((decision) => decision.entry.connectorId)).toEqual([
      "linear",
    ]);
    // 168h window minus 0.5h elapsed rounds up to a whole remaining hour.
    expect(deferred[0]?.hoursRemaining).toBe(168);
  });

  test("a source past its tier window is due with the elapsed reason", () => {
    const oldIngest = new Date(
      NOW.getTime() - 25 * 60 * 60 * 1000,
    ).toISOString();
    const { due } = planRefresh(
      { hackernews: "daily" },
      new Map([["hackernews", episode(oldIngest, "hackernews")]]),
      NOW,
    );

    expect(due).toHaveLength(1);
    expect(due[0]?.entry.reason).toBe("tier-window-elapsed");
    expect(due[0]?.entry.lastIngestIso).toBe(oldIngest);
  });

  test("an unparseable last-ingest timestamp defers to due, never silently stalls", () => {
    const broken = episode("not-a-timestamp");
    const { due, deferred } = planRefresh(
      { rss: "cold" },
      new Map([["rss", broken]]),
      NOW,
    );

    expect(deferred).toEqual([]);
    expect(due).toHaveLength(1);
    expect(due[0]?.entry.reason).toBe("tier-window-elapsed");
  });
});
