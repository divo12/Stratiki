import { readFile } from "node:fs/promises";
import { HostIntegrationError } from "../core/errors.js";
import { writeTextAtomic } from "./atomic-file.js";
import type { HostIntegrationStatus, HostMcpServerCommand } from "./types.js";

const START = "# STRATIKI:MCP:START";
const END = "# STRATIKI:MCP:END";

/**
 * Byte range occupied by one complete managed TOML block.
 */
interface MarkerRange {
  /**
   * Inclusive block start offset.
   */
  start: number;

  /**
   * Exclusive block end offset.
   */
  end: number;
}

/**
 * Installs an exact managed OpenWiki TOML block.
 *
 * @param filePath - Absolute Codex TOML config path.
 * @param entry - Exact executable invocation to install.
 * @param replaceableEntry - Exact prior invocation that may be replaced.
 * @returns Whether the config changed.
 */
export async function installCodexMcpBlock(
  filePath: string,
  entry: HostMcpServerCommand,
  replaceableEntry?: HostMcpServerCommand,
): Promise<boolean> {
  let current = await readOptional(filePath);
  const block = renderBlock(entry);
  const range = markerRange(current);
  if (range) {
    const existing = current.slice(range.start, range.end);
    if (hasUnmanagedOpenWikiTable(current, range)) {
      throw new HostIntegrationError(
        "conflict",
        `Refusing to replace a modified OpenWiki MCP block in ${filePath}.`,
      );
    }
    if (existing === block) return false;
    if (!replaceableEntry || existing !== renderBlock(replaceableEntry)) {
      throw new HostIntegrationError(
        "conflict",
        `Refusing to replace a modified OpenWiki MCP block in ${filePath}.`,
      );
    }
    await writeTextAtomic(
      filePath,
      `${current.slice(0, range.start)}${block}${current.slice(range.end)}`,
    );
    return true;
  }
  if (hasUnmanagedOpenWikiTable(current)) {
    throw new HostIntegrationError(
      "conflict",
      `An unmanaged stratiki MCP table already exists in ${filePath}.`,
    );
  }
  // Migration: drop pre-rename managed blocks so the new install does not
  // leave a second, dead server behind.
  current = stripLegacyManagedBlocks(current);

  const separator =
    current.length === 0 || current.endsWith("\n\n") ? "" : "\n";
  await writeTextAtomic(filePath, `${current}${separator}${block}`);
  return true;
}

/**
 * Removes only the exact managed OpenWiki TOML block.
 *
 * @param filePath - Absolute Codex TOML config path.
 * @param entry - Exact executable invocation owned by OpenWiki.
 * @returns Whether the config changed.
 */
export async function uninstallCodexMcpBlock(
  filePath: string,
  entry: HostMcpServerCommand,
): Promise<boolean> {
  const current = await readOptional(filePath);
  const range = markerRange(current);
  if (!range) {
    // Migration cleanup: a legacy-only config is ours to remove.
    const cleaned = stripLegacyManagedBlocks(current);
    if (cleaned !== current) {
      await writeTextAtomic(filePath, cleaned);
      return true;
    }
    return false;
  }
  if (
    current.slice(range.start, range.end) !== renderBlock(entry) ||
    hasUnmanagedOpenWikiTable(current, range)
  ) {
    throw new HostIntegrationError(
      "conflict",
      `Refusing to remove a modified OpenWiki MCP block from ${filePath}.`,
    );
  }

  const removed = `${current.slice(0, range.start)}${current.slice(range.end)}`;
  await writeTextAtomic(filePath, stripLegacyManagedBlocks(removed));
  return true;
}

/**
 * Reports whether the exact managed Codex block is absent, intact, or modified.
 *
 * @param filePath - Absolute Codex TOML config path.
 * @param entry - Exact executable invocation expected in the managed block.
 * @returns Current managed-block state.
 */
export async function getCodexMcpBlockStatus(
  filePath: string,
  entry: HostMcpServerCommand,
): Promise<HostIntegrationStatus> {
  try {
    const current = await readOptional(filePath);
    const range = markerRange(current);
    if (!range) {
      return hasUnmanagedOpenWikiTable(current) ? "modified" : "not-installed";
    }
    return current.slice(range.start, range.end) === renderBlock(entry) &&
      !hasUnmanagedOpenWikiTable(current, range)
      ? "installed"
      : "modified";
  } catch {
    return "modified";
  }
}

/**
 * Detects an OpenWiki MCP table outside the one managed marker range.
 *
 * @param content - Complete TOML config content.
 * @param managed - Expected managed block range, when present.
 * @returns Whether any matching table is outside the managed block.
 */
function hasUnmanagedOpenWikiTable(
  content: string,
  managed?: MarkerRange,
): boolean {
  for (const match of content.matchAll(
    /^\s*\[mcp_servers\.stratiki\]\s*$/gmu,
  )) {
    const index = match.index;
    if (!managed || index < managed.start || index >= managed.end) return true;
  }
  return false;
}

/**
 * Renders the canonical managed TOML block.
 *
 * @param entry - Exact executable invocation to render.
 * @returns Complete marker-delimited TOML block.
 */
function renderBlock(entry: HostMcpServerCommand): string {
  return `${START}
[mcp_servers.stratiki]
command = ${JSON.stringify(entry.command)}
args = [${entry.args.map((argument) => JSON.stringify(argument)).join(", ")}]
${END}
`;
}

/**
 * Locates and validates the managed TOML marker pair.
 *
 * @param content - Complete TOML config content.
 * @returns Managed byte range, or `null` when both markers are absent.
 */
function markerRange(content: string): MarkerRange | null {
  const start = content.indexOf(START);
  const endMarker = content.indexOf(END);
  if (start === -1 && endMarker === -1) return null;
  if (start === -1 || endMarker === -1 || endMarker < start) {
    throw new HostIntegrationError(
      "invalid_input",
      "OpenWiki MCP markers are incomplete or out of order.",
    );
  }
  if (
    content.indexOf(START, start + START.length) !== -1 ||
    content.indexOf(END, endMarker + END.length) !== -1
  ) {
    throw new HostIntegrationError(
      "invalid_input",
      "OpenWiki MCP markers appear more than once.",
    );
  }

  let end = endMarker + END.length;
  if (content[end] === "\r") end += 1;
  if (content[end] === "\n") end += 1;
  return { start, end };
}

/**
 * Reads an optional UTF-8 config file.
 *
 * @param filePath - Absolute config path.
 * @returns File content, or an empty string when absent.
 */
async function readOptional(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

const LEGACY_START = "# OPENWIKI:MCP:START";
const LEGACY_END = "# OPENWIKI:MCP:END";

/**
 * Removes pre-rename managed blocks: OPENWIKI-marker-delimited ranges and
 * standalone `[mcp_servers.openwiki]` tables whose body pins
 * `command = "openwiki"`. Foreign content under those names is left alone.
 *
 * @param content - Complete TOML config content.
 * @returns Content with recognized legacy blocks removed.
 */
function stripLegacyManagedBlocks(content: string): string {
  let result = content.replace(
    new RegExp(
      `${escapeRegExp(LEGACY_START)}[\\s\\S]*?${escapeRegExp(LEGACY_END)}\\n?`,
      "gu",
    ),
    "",
  );

  const tablePattern =
    /^[ \t]*\[mcp_servers\.openwiki\][ \t]*\n((?:[^\n[]*\n)*?)(?=^[ \t]*\[|\n?$)/gmu;
  for (const match of [...result.matchAll(tablePattern)].reverse()) {
    const body = match[1] ?? "";
    if (/^[ \t]*command[ \t]*=[ \t]*"openwiki"[ \t]*$/mu.test(body)) {
      result =
        result.slice(0, match.index) +
        result.slice((match.index ?? 0) + match[0].length);
    }
  }

  return result;
}

/**
 * Reports whether the config contains a recognizable legacy managed block.
 *
 * @param content - Complete TOML config content.
 * @returns Legacy-block presence.
 */
export function hasLegacyManagedBlock(content: string): boolean {
  if (content.includes(LEGACY_START)) {
    return true;
  }

  return stripLegacyManagedBlocks(content) !== content;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
