import { DatabaseSync } from "node:sqlite";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const tempHomes: string[] = [];

async function createTempHome(): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), "openwiki-sqlite-"));
  tempHomes.push(home);
  return home;
}

async function loadConnector(home: string) {
  vi.resetModules();
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  const { createSqliteConnector } =
    await import("../../../src/connectors/sources/sqlite.ts");
  return createSqliteConnector();
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

describe("sqlite connector ingestion", () => {
  test("snapshots schema, counts, and bounded samples read-only", async () => {
    const home = await createTempHome();
    const dataDir = path.join(home, "data");
    await mkdir(dataDir, { recursive: true });
    const databasePath = path.join(dataDir, "app.db");
    const database = new DatabaseSync(databasePath);
    database.exec("CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT)");
    database.exec("INSERT INTO projects (name) VALUES ('alpha'), ('beta')");
    database.close();

    const connector = await loadConnector(home);
    const result = await connector.ingest({
      connectorConfig: {
        maxRowsPerTable: 10,
        path: databasePath,
        tables: ["projects"],
      },
      limit: 10,
    });

    expect(result.status).toBe("success");

    const dump = JSON.parse(
      await readFile(result.rawFiles[0] ?? "", "utf8"),
    ) as {
      databasePath: string;
      tables: {
        columns: { name: string; type: string }[];
        name: string;
        rowCount: number;
        rows: Record<string, unknown>[];
      }[];
    };
    expect(dump.databasePath).toBe(path.resolve(databasePath));
    expect(dump.tables).toHaveLength(1);
    expect(dump.tables[0]?.name).toBe("projects");
    expect(dump.tables[0]?.rowCount).toBe(2);
    expect(dump.tables[0]?.columns.map((column) => column.name)).toEqual([
      "id",
      "name",
    ]);
    expect(dump.tables[0]?.rows).toHaveLength(2);
  });

  test("discovers user tables when none are configured", async () => {
    const home = await createTempHome();
    const databasePath = path.join(home, "app.db");
    const database = new DatabaseSync(databasePath);
    database.exec("CREATE TABLE notes (body TEXT)");
    database.close();

    const connector = await loadConnector(home);
    const result = await connector.ingest({
      connectorConfig: { path: databasePath },
    });

    expect(result.status).toBe("success");
    const dump = JSON.parse(
      await readFile(result.rawFiles[0] ?? "", "utf8"),
    ) as {
      tables: { name: string }[];
    };
    expect(dump.tables.map((table) => table.name)).toEqual(["notes"]);
  });

  test("skips when not enabled and errors without a database path", async () => {
    const home = await createTempHome();
    const connector = await loadConnector(home);

    const skippedDisabled = await connector.ingest({
      connectorConfig: { enabled: false },
    });
    expect(skippedDisabled.status).toBe("skipped");

    const erroredMissing = await connector.ingest({
      connectorConfig: { path: "" },
    });
    expect(erroredMissing.status).toBe("error");

    const erroredAbsent = await connector.ingest({
      connectorConfig: { path: path.join(home, "missing.db") },
    });
    expect(erroredAbsent.status).toBe("error");
  });
});
