import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { BookLease } from "../../src/book/lease.js";

const tempDirs: string[] = [];

async function createLeaseDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "stratiki-lease-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })),
  );
});

describe("BookLease", () => {
  test("acquires an absent lease and records owner plus timestamp", async () => {
    const dir = await createLeaseDir();
    const leasePath = path.join(dir, "refresh.lock");
    const lease = BookLease.at(leasePath, "daemon-1");

    const result = await lease.acquire();

    expect(result.outcome).toBe("acquired");
    const onDisk = JSON.parse(await readFile(leasePath, "utf8")) as Record<
      string,
      string
    >;
    expect(onDisk.owner).toBe("daemon-1");
  });

  test("a live lease blocks a second acquirer", async () => {
    const dir = await createLeaseDir();
    const leasePath = path.join(dir, "refresh.lock");
    const first = BookLease.at(leasePath, "daemon-1");
    await first.acquire(new Date("2026-08-22T12:00:00Z"));

    const second = BookLease.at(leasePath, "daemon-2");
    const result = await second.acquire(new Date("2026-08-22T12:10:00Z"));

    expect(result.outcome).toBe("held-by-other");
    if (result.outcome === "held-by-other") {
      expect(result.holder.owner).toBe("daemon-1");
    }
  });

  test("a stale lease beyond the TTL can be broken", async () => {
    const dir = await createLeaseDir();
    const leasePath = path.join(dir, "refresh.lock");
    const crashed = BookLease.at(leasePath, "crashed-daemon");
    await crashed.acquire(new Date("2026-08-22T12:00:00Z"));

    const next = BookLease.at(leasePath, "recovery-daemon");
    // One hour TTL has elapsed by 13:01.
    const result = await next.acquire(new Date("2026-08-22T13:01:00Z"));

    expect(result.outcome).toBe("acquired");
  });

  test("release removes the file only when owned by the releaser", async () => {
    const dir = await createLeaseDir();
    const leasePath = path.join(dir, "refresh.lock");
    const first = BookLease.at(leasePath, "daemon-1");
    await first.acquire();
    await first.release();

    await expect(readFile(leasePath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("release never deletes another daemon's live lease", async () => {
    const dir = await createLeaseDir();
    const leasePath = path.join(dir, "refresh.lock");

    // Simulate a foreign holder by writing its lease directly.
    await writeFile(
      leasePath,
      JSON.stringify({
        acquiredAtIso: new Date().toISOString(),
        owner: "other",
      }),
      "utf8",
    );
    const impostor = BookLease.at(leasePath, "impostor");
    await impostor.release();

    const stillThere = JSON.parse(await readFile(leasePath, "utf8")) as {
      owner: string;
    };
    expect(stillThere.owner).toBe("other");
  });
});
