import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  BOOK_MANIFEST_FILENAME,
  BookManifestError,
  WorkspaceManifest,
} from "../../src/book/manifest.js";
import { BOOK_SECTIONS } from "../../src/book/types.js";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "stratiki-book-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })),
  );
});

describe("WorkspaceManifest.createDefault", () => {
  test("seeds one base coverage requirement per U1-U7 section", () => {
    const manifest = WorkspaceManifest.createDefault("Acme");

    const grouped = manifest.requirementsBySection();
    for (const sectionId of BOOK_SECTIONS) {
      expect(grouped[sectionId]).toHaveLength(1);
      expect(grouped[sectionId][0]?.id).toBe(`${sectionId}.base`);
    }
    expect(manifest.name).toBe("Acme");
    expect(manifest.version).toBe(1);
  });

  test("round-trips through save and load", async () => {
    const dir = await createTempDir();
    const manifestPath = path.join(dir, "openwiki", BOOK_MANIFEST_FILENAME);

    await WorkspaceManifest.createDefault("Acme", "The Acme system").save(
      manifestPath,
    );
    const loaded = await WorkspaceManifest.load(manifestPath);

    expect(loaded.name).toBe("Acme");
    expect(loaded.description).toBe("The Acme system");
    expect(Object.keys(loaded.requirementsBySection())).toHaveLength(7);
  });
});

describe("WorkspaceManifest.parse", () => {
  test("accepts a valid full manifest and preserves custom requirements", () => {
    const manifest = WorkspaceManifest.parse({
      name: "Arceus",
      requirements: [
        {
          description: "Checkout flow latency p95 is documented.",
          id: "u6.checkout-latency",
          minimumEvidenceSources: 2,
          sectionId: "u6-gaps",
        },
      ],
      sourceTiers: [{ connectorId: "github", tier: "daily" }],
      version: 1,
    });

    const grouped = manifest.requirementsBySection();
    expect(grouped["u3-architecture"]).toHaveLength(0);
    expect(grouped["u6-gaps"]).toHaveLength(1);
    expect(grouped["u6-gaps"][0]?.minimumEvidenceSources).toBe(2);
    expect(manifest.tierForConnector("github")).toBe("daily");
    // Unassigned connectors fall back to the weekly tier.
    expect(manifest.tierForConnector("slack")).toBe("weekly");
  });

  test("applies minimumEvidenceSources default without mutating intent", () => {
    const manifest = WorkspaceManifest.parse({
      name: "Acme",
      requirements: [
        {
          description: "Deploy pipeline is documented.",
          id: "u7.deploy",
          sectionId: "u7-operations",
        },
      ],
      version: 1,
    });

    expect(
      manifest.requirementsBySection()["u7-operations"][0]
        ?.minimumEvidenceSources,
    ).toBe(1);
  });

  test.each([
    [{ version: 1 }, "name"],
    [{ name: "", version: 1 }, "name"],
    [
      {
        name: "Acme",
        requirements: [{ description: "x", id: "r1", sectionId: "u8-nope" }],
        version: 1,
      },
      "sectionId",
    ],
    [{ name: "Acme", version: 2 }, "version"],
    ["not-an-object", "(root)"],
  ])("rejects invalid manifest %j", (body, expectedFragment) => {
    expect(() => WorkspaceManifest.parse(body)).toThrow(BookManifestError);
    try {
      WorkspaceManifest.parse(body);
    } catch (error) {
      expect((error as Error).message).toContain(expectedFragment);
    }
  });

  test("error message aggregates every issue with its path", () => {
    try {
      WorkspaceManifest.parse({
        name: "Acme",
        requirements: [{ description: "", id: "", sectionId: "u9-bogus" }],
        version: 1,
      });
      expect.unreachable();
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("requirements.0.id");
      expect(message).toContain("requirements.0.sectionId");
    }
  });
});

describe("WorkspaceManifest.save", () => {
  test("writes stable, pretty-printed JSON including defaults", async () => {
    const dir = await createTempDir();
    const manifestPath = path.join(dir, BOOK_MANIFEST_FILENAME);

    await WorkspaceManifest.createDefault("acme inc").save(manifestPath);

    const onDisk = JSON.parse(await readFile(manifestPath, "utf8")) as Record<
      string,
      unknown
    >;
    expect(onDisk.version).toBe(1);
    expect(onDisk.name).toBe("acme inc");
    expect(Array.isArray(onDisk.requirements)).toBe(true);
    expect(onDisk.sourceTiers).toEqual([]);
  });
});
