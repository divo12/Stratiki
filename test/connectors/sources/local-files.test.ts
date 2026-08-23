import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const tempHomes: string[] = [];

async function createTempHome(): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), "openwiki-local-files-"));
  tempHomes.push(home);
  return home;
}

async function loadConnector(home: string) {
  vi.resetModules();
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  const { createLocalFilesConnector } =
    await import("../../../src/connectors/sources/local-files.ts");
  return createLocalFilesConnector();
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

describe("local-files connector ingestion", () => {
  test("manifests metadata without contents and skips ignored trees", async () => {
    const home = await createTempHome();
    await mkdir(path.join(home, "Desktop"), { recursive: true });
    await mkdir(path.join(home, "Desktop", "node_modules"), {
      recursive: true,
    });
    await mkdir(path.join(home, "Documents"), { recursive: true });
    await writeFile(path.join(home, "Desktop", "notes.md"), "# notes");
    await writeFile(path.join(home, "Desktop", "node_modules", "junk.js"), "x");
    await writeFile(path.join(home, "Documents", "report.pdf"), "%PDF");
    await writeFile(path.join(home, "Desktop", "app.exe"), "MZ");

    const connector = await loadConnector(home);
    const result = await connector.ingest({
      connectorConfig: { directories: ["Desktop", "Documents"] },
    });

    expect(result.status).toBe("success");

    const dump = JSON.parse(
      await readFile(result.rawFiles[0] ?? "", "utf8"),
    ) as { entries: { bytes: number; extension: string; path: string }[] };
    const paths = dump.entries.map((entry) => entry.path).sort();
    // Home-relative paths only; ignored directories and extensions excluded.
    expect(paths).toEqual(["Desktop/notes.md", "Documents/report.pdf"]);
    expect(dump.entries.every((entry) => entry.bytes > 0)).toBe(true);
    expect(dump.entries.some((entry) => entry.path.includes(home))).toBe(false);
  });

  test("enforces the file budget across the whole walk", async () => {
    const home = await createTempHome();
    await mkdir(path.join(home, "Downloads"), { recursive: true });
    for (let index = 0; index < 5; index += 1) {
      await writeFile(
        path.join(home, "Downloads", `file-${index}.txt`),
        "content",
      );
    }

    const connector = await loadConnector(home);
    const result = await connector.ingest({
      connectorConfig: { directories: ["Downloads"] },
      limit: 2,
    });

    expect(result.status).toBe("success");

    const dump = JSON.parse(
      await readFile(result.rawFiles[0] ?? "", "utf8"),
    ) as { entries: unknown[] };
    expect(dump.entries).toHaveLength(2);
  });

  test("rejects absolute and traversal directories outside the home", async () => {
    const home = await createTempHome();
    await mkdir(path.join(home, "Documents"), { recursive: true });
    const outside = await mkdtemp(path.join(tmpdir(), "openwiki-outside-"));
    tempHomes.push(outside);
    await writeFile(path.join(outside, "secret.txt"), "secret");
    await writeFile(path.join(home, "Documents", "keep.txt"), "safe");

    const connector = await loadConnector(home);
    const result = await connector.ingest({
      connectorConfig: {
        directories: [outside, "../", "Documents", "../../etc"],
      },
    });

    // Only the safe home-relative directory is walked; escapes are skipped
    // with warnings and never appear in the manifest.
    expect(result.status).toBe("success");
    const dump = JSON.parse(
      await readFile(result.rawFiles[0] ?? "", "utf8"),
    ) as {
      entries: { path: string }[];
    };
    expect(dump.entries.map((entry) => entry.path)).toEqual([
      "Documents/keep.txt",
    ]);
    expect(result.warnings.length).toBeGreaterThanOrEqual(3);
  });

  test("skips when not enabled and errors when no home is resolvable", async () => {
    const home = await createTempHome();
    const connector = await loadConnector(home);

    const skipped = await connector.ingest({
      connectorConfig: { enabled: false },
    });
    expect(skipped.status).toBe("skipped");

    delete process.env.HOME;
    delete process.env.USERPROFILE;
    const errored = await connector.ingest();
    expect(errored.status).toBe("error");
    expect(errored.message).toContain("home directory");
  });
});
