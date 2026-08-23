import { readFile } from "node:fs/promises";
import { HostIntegrationError } from "../core/errors.js";
import { writeTextAtomic } from "./atomic-file.js";
import type { HostIntegrationStatus, HostMcpServerCommand } from "./types.js";

/**
 * Installs the managed Stratiki entry without discarding unrelated config.
 *
 * @param filePath - Absolute OpenCode JSON config path.
 * @param entry - Exact registry-derived entry to own.
 * @param replaceableEntry - Exact prior entry that may be replaced.
 * @returns Whether the config changed.
 */
export async function installOpenCodeMcpEntry(
  filePath: string,
  entry: HostMcpServerCommand,
  replaceableEntry?: HostMcpServerCommand,
): Promise<boolean> {
  const root = (await readJsonObject(filePath)) ?? {};
  const servers = asObject(root.mcp, "mcp", filePath);
  const existing = servers.stratiki;
  if (existing !== undefined) {
    if (matchesEntry(existing, entry)) return false;
    if (replaceableEntry && matchesEntry(existing, replaceableEntry)) {
      servers.stratiki = renderEntry(entry);
      root.mcp = servers;
      await writeTextAtomic(filePath, `${JSON.stringify(root, null, 2)}\n`);
      return true;
    }
    throw new HostIntegrationError(
      "conflict",
      `A stratiki MCP server already exists in ${filePath}.`,
    );
  }

  servers.stratiki = renderEntry(entry);
  root.mcp = servers;
  await writeTextAtomic(filePath, `${JSON.stringify(root, null, 2)}\n`);
  return true;
}

/**
 * Removes only an exact managed Stratiki entry.
 *
 * @param filePath - Absolute OpenCode JSON config path.
 * @param expected - Exact entry previously installed by Stratiki.
 * @returns Whether the config changed.
 */
export async function uninstallOpenCodeMcpEntry(
  filePath: string,
  expected: HostMcpServerCommand,
): Promise<boolean> {
  const root = await readJsonObject(filePath, true);
  if (root === null) return false;

  const servers = asObject(root.mcp, "mcp", filePath);
  const existing = servers.stratiki;
  if (existing === undefined) return false;
  if (!matchesEntry(existing, expected)) {
    throw new HostIntegrationError(
      "conflict",
      `Refusing to remove a modified stratiki MCP entry from ${filePath}.`,
    );
  }

  delete servers.stratiki;
  root.mcp = servers;
  await writeTextAtomic(filePath, `${JSON.stringify(root, null, 2)}\n`);
  return true;
}

/**
 * Reports whether the exact managed OpenCode entry is absent, intact, or modified.
 *
 * @param filePath - Absolute OpenCode JSON config path.
 * @param expected - Exact registry-derived entry Stratiki owns.
 * @returns Current managed-entry state.
 */
export async function getOpenCodeMcpEntryStatus(
  filePath: string,
  expected: HostMcpServerCommand,
): Promise<HostIntegrationStatus> {
  try {
    const root = await readJsonObject(filePath, true);
    if (root === null) return "not-installed";
    const servers = asObject(root.mcp, "mcp", filePath);
    if (servers.stratiki === undefined) return "not-installed";
    return matchesEntry(servers.stratiki, expected) ? "installed" : "modified";
  } catch {
    return "modified";
  }
}

/**
 * Renders the exact local-server shape OpenCode launches.
 *
 * @param entry - Registry-derived executable invocation.
 * @returns Complete OpenCode MCP server entry.
 */
function renderEntry(entry: HostMcpServerCommand): Record<string, unknown> {
  return {
    type: "local",
    command: [entry.command, ...entry.args],
    enabled: true,
  };
}

/**
 * Reads and validates the root JSON object.
 *
 * @param filePath - Absolute JSON config path.
 * @param missingAsNull - Whether a missing file returns `null` instead of an empty object.
 * @returns Parsed root object, or `null` when explicitly requested for absence.
 */
async function readJsonObject(
  filePath: string,
  missingAsNull = false,
): Promise<Record<string, unknown> | null> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return missingAsNull ? null : {};
    }
    throw error;
  }

  try {
    return asObject(JSON.parse(raw), "root", filePath);
  } catch (error) {
    if (error instanceof HostIntegrationError) throw error;
    throw new HostIntegrationError(
      "invalid_input",
      `Cannot update malformed JSON MCP config: ${filePath}.`,
    );
  }
}

/**
 * Narrows and shallow-clones an unknown JSON value as an object.
 *
 * @param value - Candidate object value.
 * @param label - Field label used in validation errors.
 * @param filePath - Config path used in validation errors.
 * @returns Independent mutable record.
 */
function asObject(
  value: unknown,
  label: string,
  filePath: string,
): Record<string, unknown> {
  if (value === undefined && label === "mcp") return {};
  if (!isRecord(value)) {
    throw new HostIntegrationError(
      "invalid_input",
      `${label} must be an object in ${filePath}.`,
    );
  }
  return { ...value };
}

/**
 * Compares an unknown JSON value with the exact managed entry shape.
 *
 * @param value - Existing `mcp.stratiki` value.
 * @param expected - Registry-derived managed invocation.
 * @returns Whether the value is structurally identical to the managed entry.
 */
function matchesEntry(value: unknown, expected: HostMcpServerCommand): boolean {
  if (!isRecord(value)) return false;
  if (
    Object.keys(value).length !== 3 ||
    value.type !== "local" ||
    value.enabled !== true
  ) {
    return false;
  }
  const command = value.command;
  return (
    Array.isArray(command) &&
    command.length === expected.args.length + 1 &&
    command[0] === expected.command &&
    command
      .slice(1)
      .every((argument, index) => argument === expected.args[index])
  );
}

/**
 * Narrows an unknown value to a non-array object.
 *
 * @param value - Candidate object value.
 * @returns Whether the value is a string-keyed record.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
