import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  listExpiredPartitionNames,
  readLakeRetentionPolicy,
  resolveRetentionDays,
} from "../../src/connectors/retention.ts";
import type { LakeRetentionPolicy } from "../../src/connectors/retention.ts";

const TODAY = new Date("2026-08-23T12:00:00Z");
const tempRoots: string[] = [];

async function createTempHome(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "openwiki-retention-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("lake retention policy", () => {
  test("resolves per-connector overrides over the default", () => {
    const policy: LakeRetentionPolicy = {
      defaultRetentionDays: 30,
      connectors: { stripe: { retentionDays: 7 } },
    };

    expect(resolveRetentionDays(policy, "stripe")).toBe(7);
    expect(resolveRetentionDays(policy, "claude")).toBe(30);
    expect(resolveRetentionDays({}, "stripe")).toBeNull();
    // Invalid values never activate deletion.
    expect(
      resolveRetentionDays({ defaultRetentionDays: 0 }, "stripe"),
    ).toBeNull();
    expect(
      resolveRetentionDays({ defaultRetentionDays: -5 }, "stripe"),
    ).toBeNull();
  });

  test("expires only strict dt= partitions older than the TTL", () => {
    expect(
      listExpiredPartitionNames(
        [
          "dt=2026-08-01",
          "dt=2026-08-17", // first day inside the 7-day calendar window: kept
          "dt=2026-08-16", // one day past the window: expired
          "dt=not-a-date",
          "2026-07-01T000000Z", // legacy flat run: never eligible
          "random-dir",
        ],
        7,
        TODAY,
      ),
    ).toEqual(["dt=2026-08-01", "dt=2026-08-16"]);
  });

  test("keeps everything forever without a TTL", () => {
    expect(listExpiredPartitionNames(["dt=2020-01-01"], null, TODAY)).toEqual(
      [],
    );
  });

  test("deletes only expired partitions on disk and reports them", async () => {
    const home = await createTempHome();
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    vi.resetModules();
    const { pruneConnectorRawPartitions: pruneWithTempHome } =
      await import("../../src/connectors/retention.ts");
    const rawDir = path.join(home, ".openwiki", "connectors", "stripe", "raw");
    for (const name of ["dt=2026-08-01", "dt=2026-08-22"]) {
      await mkdir(path.join(rawDir, name, "run-1"), { recursive: true });
      await writeFile(path.join(rawDir, name, "run-1", "f.json"), "{}");
    }
    await mkdir(path.join(rawDir, "2026-07-01T000000Z"), { recursive: true });

    const removed = await pruneWithTempHome(
      "stripe",
      { defaultRetentionDays: 7 },
      TODAY,
    );

    expect(removed).toEqual(["dt=2026-08-01"]);
    const remaining = await readdir(rawDir);
    expect(remaining.sort()).toEqual(["2026-07-01T000000Z", "dt=2026-08-22"]);
    delete process.env.HOME;
    delete process.env.USERPROFILE;
  });

  test("reads the policy file tolerantly", async () => {
    const home = await createTempHome();

    expect(readLakeRetentionPolicy(home)).toEqual({});

    await writeFile(
      path.join(home, "lake.json"),
      "{ defaultRetentionDays: 14, connectors: { stripe: { retentionDays: 3 } } }",
      "utf8",
    );
    const malformed = readLakeRetentionPolicy(home);
    expect(malformed).toEqual({});

    await writeFile(
      path.join(home, "lake.json"),
      JSON.stringify({
        connectors: { stripe: { retentionDays: 3 } },
        defaultRetentionDays: 14,
      }),
      "utf8",
    );
    const valid = readLakeRetentionPolicy(home);
    expect(resolveRetentionDays(valid, "stripe")).toBe(3);
    expect(resolveRetentionDays(valid, "zendesk")).toBe(14);
  });
});
