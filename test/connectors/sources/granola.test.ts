import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const tempHomes: string[] = [];

type GranolaDump = {
  meetings: { content?: string; title?: string; transcriptExcerpt?: string }[];
  sourcePath: string;
  totalParsed: number;
};

async function createTempHome(): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), "openwiki-granola-"));
  tempHomes.push(home);
  return home;
}

function setConnectorTestHome(home: string): void {
  process.env.HOME = home;
  process.env.USERPROFILE = home;
}

async function loadGranolaConnector(home: string) {
  vi.resetModules();
  setConnectorTestHome(home);
  const { createGranolaConnector } =
    await import("../../../src/connectors/sources/granola.ts");
  return createGranolaConnector();
}

function granolaAppDir(home: string): string {
  return path.join(home, "Library", "Application Support", "Granola");
}

const FRESH_UPDATED_AT = new Date(Date.now() - 60 * 60 * 1000).toISOString();
const OLD_UPDATED_AT = new Date(Date.now() - 96 * 60 * 60 * 1000).toISOString();

/** Supabase-style dump: a top-level documents array with nested notes. */
const DOCUMENTS_CACHE = {
  documents: [
    {
      id: "mtg-1",
      title: "Billing migration sync",
      created_at: FRESH_UPDATED_AT,
      updated_at: FRESH_UPDATED_AT,
      notes: {
        notes_plain:
          "Decision: cutover on Friday. Owner: Monica. Follow up on invoice retries.",
      },
      transcript_chunks: [
        { text: "Monica: we cut over Friday." },
        { text: "Jared: agreed." },
      ],
    },
    {
      id: "mtg-2",
      title: "Old roadmap review",
      created_at: OLD_UPDATED_AT,
      updated_at: OLD_UPDATED_AT,
      notes: { markdown: "# Roadmap\n- shipped v1" },
    },
    {
      id: "mtg-empty",
      // No title and no note text must be skipped by toMeeting.
    },
  ],
};

afterEach(async () => {
  vi.resetModules();
  vi.unstubAllGlobals();

  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  if (originalUserProfile === undefined) {
    delete process.env.USERPROFILE;
  } else {
    process.env.USERPROFILE = originalUserProfile;
  }

  await Promise.all(
    tempHomes
      .splice(0)
      .map((home) => rm(home, { force: true, recursive: true })),
  );
});

describe("granola connector discovery and parsing", () => {
  test("discovers the document cache in the default app directory", async () => {
    const home = await createTempHome();
    await writeGranolaCache(
      home,
      "supabase.json",
      JSON.stringify(DOCUMENTS_CACHE),
    );
    const connector = await loadGranolaConnector(home);

    const result = await connector.ingest();

    expect(result.status).toBe("success");
    expect(result.warnings).toEqual([]);

    const dump = JSON.parse(
      await readFile(result.rawFiles[0] ?? "", "utf8"),
    ) as GranolaDump;
    expect(dump.sourcePath).toBe(
      path.join(granolaAppDir(home), "supabase.json"),
    );
    // The empty entry is skipped; newest first.
    expect(dump.totalParsed).toBe(2);
    expect(dump.meetings[0]?.title).toBe("Billing migration sync");
    expect(dump.meetings[0]?.content).toContain("cutover on Friday");

    // Transcripts are excluded by default.
    expect(dump.meetings[0]?.transcriptExcerpt).toBeUndefined();
  });

  test("parses an alternate cache shape with a top-level meetings array", async () => {
    const home = await createTempHome();
    await writeGranolaCache(
      home,
      "cache-v2.json",
      JSON.stringify({
        data: {
          meetings: [
            {
              id: "m-9",
              title: "Design review",
              updated_at: FRESH_UPDATED_AT,
              notes: { notes_markdown: "Keep the graph panel collapsible." },
            },
          ],
        },
      }),
    );
    const connector = await loadGranolaConnector(home);

    const result = await connector.ingest();

    expect(result.status).toBe("success");
    const dump = JSON.parse(
      await readFile(result.rawFiles[0] ?? "", "utf8"),
    ) as GranolaDump;
    expect(dump.meetings[0]?.content).toContain("collapsible");
  });

  test("prefers the most recently modified candidate cache file", async () => {
    const home = await createTempHome();
    await writeGranolaCache(
      home,
      "cache-v1.json",
      JSON.stringify({ unrelated: true }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    await writeGranolaCache(
      home,
      "supabase.json",
      JSON.stringify(DOCUMENTS_CACHE),
    );
    const connector = await loadGranolaConnector(home);

    const result = await connector.ingest();

    expect(result.status).toBe("success");
    const dump = JSON.parse(
      await readFile(result.rawFiles[0] ?? "", "utf8"),
    ) as GranolaDump;
    expect(dump.sourcePath.endsWith("supabase.json")).toBe(true);
  });

  test("includes a bounded transcript excerpt when requested", async () => {
    const home = await createTempHome();
    await writeGranolaCache(
      home,
      "supabase.json",
      JSON.stringify(DOCUMENTS_CACHE),
    );
    const connector = await loadGranolaConnector(home);

    const result = await connector.ingest({
      connectorConfig: { includeTranscript: true },
    });

    expect(result.status).toBe("success");
    const dump = JSON.parse(
      await readFile(result.rawFiles[0] ?? "", "utf8"),
    ) as GranolaDump;
    expect(dump.meetings[0]?.transcriptExcerpt).toContain("we cut over Friday");
  });
});

describe("granola connector windowing and limits", () => {
  test("applies the time window to drop stale meetings", async () => {
    const home = await createTempHome();
    await writeGranolaCache(
      home,
      "supabase.json",
      JSON.stringify(DOCUMENTS_CACHE),
    );
    const connector = await loadGranolaConnector(home);

    const result = await connector.ingest({ windowHours: 24 });

    expect(result.status).toBe("success");
    const dump = JSON.parse(
      await readFile(result.rawFiles[0] ?? "", "utf8"),
    ) as GranolaDump;
    // The 96h-old meeting falls outside the 24h window.
    expect(dump.meetings.map((meeting) => meeting.title)).toEqual([
      "Billing migration sync",
    ]);
  });

  test("caps the number of meetings written, keeping the freshest", async () => {
    const home = await createTempHome();
    await writeGranolaCache(
      home,
      "supabase.json",
      JSON.stringify(DOCUMENTS_CACHE),
    );
    const connector = await loadGranolaConnector(home);

    const result = await connector.ingest({
      connectorConfig: { maxMeetings: 1 },
    });

    expect(result.status).toBe("success");
    const dump = JSON.parse(
      await readFile(result.rawFiles[0] ?? "", "utf8"),
    ) as GranolaDump;
    expect(dump.totalParsed).toBe(2);
    expect(dump.meetings).toHaveLength(1);
    expect(dump.meetings[0]?.title).toBe("Billing migration sync");
  });

  test("honors an explicit notesPath override", async () => {
    const home = await createTempHome();
    const customPath = path.join(home, "export.json");
    await writeFile(customPath, JSON.stringify(DOCUMENTS_CACHE), "utf8");
    const connector = await loadGranolaConnector(home);

    const result = await connector.ingest({
      connectorConfig: { notesPath: "~/export.json" },
    });

    expect(result.status).toBe("success");
    const dump = JSON.parse(
      await readFile(result.rawFiles[0] ?? "", "utf8"),
    ) as GranolaDump;
    expect(dump.sourcePath).toBe(customPath);
  });
});

describe("granola connector gating and failure modes", () => {
  test("skips without reading when disabled", async () => {
    const home = await createTempHome();
    const connector = await loadGranolaConnector(home);

    const result = await connector.ingest({
      connectorConfig: { enabled: false },
    });

    expect(result.status).toBe("skipped");
    expect(result.message).toContain("not enabled");
  });

  test("errors with guidance when no cache exists", async () => {
    const home = await createTempHome();
    const connector = await loadGranolaConnector(home);

    const result = await connector.ingest();

    expect(result.status).toBe("error");
    expect(result.rawFiles).toEqual([]);
    expect(result.message).toContain("No Granola document cache found");
    expect(result.warnings.join("\n")).toContain(granolaAppDir(home));
  });

  test("errors when the configured notesPath does not exist", async () => {
    const home = await createTempHome();
    const connector = await loadGranolaConnector(home);

    const result = await connector.ingest({
      connectorConfig: { notesPath: "~/missing/granola.json" },
    });

    expect(result.status).toBe("error");
    expect(result.message).toContain("Failed to read the Granola cache");
  });

  test("warns when a discovered file has no recognizable documents list", async () => {
    const home = await createTempHome();
    await writeGranolaCache(
      home,
      "settings.json",
      JSON.stringify({ theme: "dark" }),
    );
    const connector = await loadGranolaConnector(home);

    const result = await connector.ingest();

    // No structural match anywhere means discovery fails with guidance.
    expect(result.status).toBe("error");
    expect(result.message).toContain("No Granola document cache found");
  });
});

async function writeGranolaCache(
  home: string,
  filename: string,
  contents: string,
): Promise<void> {
  const dir = granolaAppDir(home);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, filename), contents, "utf8");
}
