import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { ContextIndex, renderPacket } from "../../src/book/packet.js";

const tempDirs: string[] = [];

async function createWiki(pages: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "stratiki-packet-"));
  tempDirs.push(dir);
  for (const [relativePath, content] of Object.entries(pages)) {
    const fullPath = path.join(dir, relativePath);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content, "utf8");
  }

  return dir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })),
  );
});

describe("ContextIndex", () => {
  test("indexes nested markdown and ranks matching pages", async () => {
    const wikiDir = await createWiki({
      "architecture/overview.md":
        "---\ntitle: Architecture\n---\nThe deploy pipeline uses blue-green releases.",
      "quickstart.md":
        "# Quickstart\nRun stratiki init to generate the book. The deploy pipeline is documented elsewhere.",
      "claims/notes.md": "Unrelated content about coffee preferences.",
    });
    const index = await ContextIndex.buildFromDirectory(wikiDir);

    try {
      const entries = index.search("deploy pipeline");

      expect(entries.length).toBeGreaterThanOrEqual(2);
      expect(entries.map((entry) => entry.path)).toContain("/quickstart.md");
      // Titles come from front matter or the first heading.
      const architecture = entries.find(
        (entry) => entry.path === "/architecture/overview.md",
      );
      expect(architecture?.title).toBe("Architecture");
      const quickstart = entries.find(
        (entry) => entry.path === "/quickstart.md",
      );
      expect(quickstart?.title).toBe("Quickstart");
    } finally {
      index.close();
    }
  });

  test("skips dot-directories like .claims", async () => {
    const wikiDir = await createWiki({
      ".claims/secret-page.md":
        "Internal claim metadata should never be searchable.",
      "public.md": "# Public page\nVisible knowledge.",
    });
    const index = await ContextIndex.buildFromDirectory(wikiDir);

    try {
      expect(index.search("claim metadata")).toEqual([]);
      expect(
        index.search("visible knowledge").map((entry) => entry.path),
      ).toEqual(["/public.md"]);
    } finally {
      index.close();
    }
  });

  test("degrades malformed queries to an empty result instead of throwing", async () => {
    const wikiDir = await createWiki({ "a.md": "hello world" });
    const index = await ContextIndex.buildFromDirectory(wikiDir);

    try {
      expect(index.search("AND OR NOT (")).toEqual([]);
      expect(index.search("   ")).toEqual([]);
    } finally {
      index.close();
    }
  });
});

describe("renderPacket", () => {
  test("renders provenance-first markdown", () => {
    const packet = renderPacket("deploy pipeline", [
      {
        excerpt: ">>blue-green<< releases",
        path: "/arch.md",
        title: "Architecture",
      },
    ]);

    expect(packet).toContain("# Context packet");
    expect(packet).toContain("_Source: /arch.md_");
    expect(packet).toContain(">>blue-green<<");
  });

  test("states plainly when nothing matched", () => {
    const packet = renderPacket("nothing-here", []);

    expect(packet).toContain("No book pages matched");
  });
});
