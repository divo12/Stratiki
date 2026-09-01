import { DatabaseSync } from "node:sqlite";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

/**
 * The context packet service: a deterministic, LLM-free retrieval layer over
 * the generated book. Pages are indexed into SQLite FTS5; queries return the
 * most relevant page excerpts with their source paths so an agent (or human)
 * gets grounded context without reading the whole wiki. Search never calls a
 * model — the packet is assembled purely from the index.
 */

export class ContextIndex {
  private constructor(private readonly db: DatabaseSync) {}

  /** Opens an in-memory index and populates it from a directory of pages. */
  static async buildFromDirectory(wikiDir: string): Promise<ContextIndex> {
    const db = new DatabaseSync(":memory:");
    db.exec(`
CREATE VIRTUAL TABLE IF NOT EXISTS pages USING fts5(
  path UNINDEXED,
  title,
  body
);
`);
    const index = new ContextIndex(db);
    const files = await listMarkdownFiles(wikiDir);
    const insert = db.prepare(
      "INSERT INTO pages (path, title, body) VALUES (?, ?, ?)",
    );
    for (const filePath of files) {
      const raw = await readFile(filePath, "utf8");
      insert.run(
        toRelativeDisplayPath(wikiDir, filePath),
        extractTitle(raw, filePath),
        stripFrontMatter(raw),
      );
    }

    return index;
  }

  close(): void {
    this.db.close();
  }

  /**
   * Runs an FTS5 query and returns compact packet entries. FTS5 syntax
   * errors from user input degrade to an empty result set rather than
   * throwing — a malformed query must not crash the daemon.
   */
  search(query: string, limit = 5): ContextPacketEntry[] {
    if (query.trim().length === 0) {
      return [];
    }

    try {
      const rows = this.db
        .prepare(
          `SELECT path, title, snippet(pages, 2, '>>', '<<', ' … ', 24) AS excerpt
FROM pages WHERE pages MATCH ? ORDER BY rank LIMIT ?`,
        )
        .all(sanitizeFtsQuery(query), limit) as {
        excerpt: string;
        path: string;
        title: string;
      }[];

      return rows.map((row) => ({
        excerpt: row.excerpt,
        path: row.path,
        title: row.title,
      }));
    } catch {
      return [];
    }
  }
}

export interface ContextPacketEntry {
  readonly excerpt: string;
  readonly path: string;
  readonly title: string;
}

/**
 * Renders the retrieved entries as a Markdown packet with provenance paths,
 * ready for injection into an agent prompt.
 */
export function renderPacket(
  query: string,
  entries: readonly ContextPacketEntry[],
): string {
  if (entries.length === 0) {
    return `# Context packet\n\nNo book pages matched "${query}".\n`;
  }

  const sections = entries
    .map(
      (entry) =>
        `## ${entry.title}\n\n_Source: ${entry.path}_\n\n${entry.excerpt}\n`,
    )
    .join("\n");

  return `# Context packet\n\nQuery: ${query}\n\n${sections}`;
}

async function listMarkdownFiles(dir: string): Promise<string[]> {
  const collected: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return collected;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === ".claims" || entry.name.startsWith(".")) {
        continue;
      }
      collected.push(...(await listMarkdownFiles(fullPath)));
    } else if (entry.name.endsWith(".md")) {
      collected.push(fullPath);
    }
  }

  return collected.sort();
}

function toRelativeDisplayPath(wikiDir: string, filePath: string): string {
  return `/${path.relative(wikiDir, filePath).split(path.sep).join("/")}`;
}

function extractTitle(raw: string, filePath: string): string {
  const frontMatterTitle = raw
    .match(/^---[\s\S]*?^title:\s*(.+)$/mu)?.[1]
    ?.trim();
  if (frontMatterTitle !== undefined && frontMatterTitle.length > 0) {
    return stripQuotes(frontMatterTitle);
  }

  const heading = raw.match(/^#\s+(.+)$/mu)?.[1]?.trim();
  if (heading !== undefined && heading.length > 0) {
    return heading;
  }

  return path.basename(filePath, ".md");
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();

  return trimmed.length > 1 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
    ? trimmed.slice(1, -1)
    : trimmed;
}

/** Drops YAML front matter so its keys do not pollute full-text matching. */
function stripFrontMatter(raw: string): string {
  return raw.replace(/^---\n[\s\S]*?\n---\n/u, "");
}

/**
 * Quotes each token so user input is treated as literal terms instead of FTS5
 * control syntax (column filters, NEAR, boolean operators).
 */
function sanitizeFtsQuery(query: string): string {
  const tokens = query
    .trim()
    .split(/\s+/u)
    .slice(0, 12)
    .map((token) => token.replace(/["'()*:^]/gu, ""));

  return tokens.filter((token) => token.length > 0).join(" ");
}
