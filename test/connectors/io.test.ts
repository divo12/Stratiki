import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createRunId } from "../../src/connectors/io.ts";

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const tempHomes: string[] = [];

async function createTempHome(): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), "openwiki-io-"));
  tempHomes.push(home);
  return home;
}

async function loadIo(home: string) {
  vi.resetModules();
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  return await import("../../src/connectors/io.ts");
}

afterEach(async () => {
  vi.resetModules();

  const restore = (name: string, value: string | undefined): void => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  restore("HOME", originalHome);
  restore("USERPROFILE", originalUserProfile);

  await Promise.all(
    tempHomes
      .splice(0)
      .map((home) => rm(home, { force: true, recursive: true })),
  );
});

describe("raw zone date partitions", () => {
  test("writes dumps under dt=YYYY-MM-DD/<run-id>/", async () => {
    const home = await createTempHome();
    const io = await loadIo(home);
    const runId = createRunId();

    const filePath = await io.writeRawJson(
      "stripe",
      runId,
      "stripe-events.json",
      { events: [] },
    );

    const today = new Date().toISOString().slice(0, 10);
    expect(filePath).toContain(`dt=${today}`);
    expect(filePath).toContain(
      path.join("connectors", "stripe", "raw", `dt=${today}`, runId),
    );

    // The written bytes and private permissions are unchanged by layout.
    expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual({
      events: [],
    });
    const partitionDir = io.getRawPartitionDir("stripe", new Date());
    expect((await readdir(partitionDir)).sort()).toEqual([runId]);
  });

  test("same-day runs group into one partition directory", async () => {
    const home = await createTempHome();
    const io = await loadIo(home);

    await io.writeRawJson("zendesk", createRunId(), "a.json", {});
    await io.writeRawJson("zendesk", createRunId(), "b.json", {});

    const today = new Date().toISOString().slice(0, 10);
    const partitionDir = path.join(
      home,
      ".openwiki",
      "connectors",
      "zendesk",
      "raw",
      `dt=${today}`,
    );
    expect((await readdir(partitionDir)).length).toBe(2);
  });
});
