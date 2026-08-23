import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import {
  createRunId,
  readConnectorConfig,
  readConnectorState,
  updateStateWithRun,
  writeConnectorState,
  writeRawJson,
} from "../io.js";
import { openWikiConnectorsDisplayPath } from "../../config/openwiki-home.js";
import type {
  ConnectorDefinition,
  ConnectorIngestOptions,
  ConnectorIngestResult,
  ConnectorRuntime,
} from "../types.js";

type LocalFilesConfig = {
  directories?: string[];
  enabled?: boolean;
  maxFiles?: number;
};

type FileEntry = {
  bytes: number;
  extension: string;
  modifiedAt: string;
  path: string;
};

const DEFAULT_DIRECTORIES = ["Desktop", "Documents", "Downloads"];
const IGNORED_DIRECTORY_NAMES = new Set([
  ".git",
  "node_modules",
  "Library",
  "AppData",
]);

// Binary-heavy or privacy-sensitive formats are excluded from manifests; the
// wiki only needs to know these files exist, not read them.
const IGNORED_EXTENSIONS = new Set([
  ".app",
  ".dll",
  ".dylib",
  ".exe",
  ".icloud",
  ".iso",
  ".pkg",
  ".so",
]);

const definition: ConnectorDefinition = {
  backend: "local-store",
  description:
    "Builds a metadata manifest (paths, sizes, modification times) for files in configured home-relative directories.",
  displayName: "Local Files",
  id: "local-files",
  mode: "personal",
  requiredEnv: [],
  supportsAgenticDiscovery: false,
};

export function createLocalFilesConnector(): ConnectorRuntime {
  return {
    ...definition,
    ingest,
  };
}

async function ingest(
  options: ConnectorIngestOptions = {},
): Promise<ConnectorIngestResult> {
  const runId = createRunId();
  const config = {
    ...(await readConnectorConfig<LocalFilesConfig>("local-files", {
      directories: DEFAULT_DIRECTORIES,
      enabled: true,
      maxFiles: 500,
    })),
    ...((options.connectorConfig ?? {}) as LocalFilesConfig),
  };
  const state = await readConnectorState("local-files");
  const warnings: string[] = [];
  const rawFiles: string[] = [];

  if (!config.enabled) {
    return finishLocalFilesRun({
      message: `Local Files connector is not enabled. Set enabled=true in ${openWikiConnectorsDisplayPath}/local-files/config.json.`,
      rawFiles,
      runId,
      state,
      status: "skipped",
      warnings,
    });
  }

  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (typeof home !== "string" || home.length === 0) {
    return finishLocalFilesRun({
      message:
        "Cannot resolve the home directory; set HOME or USERPROFILE and retry.",
      rawFiles,
      runId,
      state,
      status: "error",
      warnings,
    });
  }

  const maxFiles = normalizeMaxFiles(options.limit ?? config.maxFiles);
  const directories =
    config.directories && config.directories.length > 0
      ? config.directories
      : DEFAULT_DIRECTORIES;

  const files: FileEntry[] = [];
  for (const directory of directories) {
    const absoluteDirectory = path.resolve(home, directory);
    try {
      files.push(
        ...(await walkDirectory(absoluteDirectory, home, {
          remaining: () => maxFiles - files.length,
        })),
      );
    } catch (error) {
      warnings.push(`${directory}: ${getErrorMessage(error)}`);
    }
    if (files.length >= maxFiles) break;
  }

  rawFiles.push(
    await writeRawJson("local-files", runId, "files-manifest.json", {
      directories,
      entries: files.slice(0, maxFiles),
      fetchedAt: new Date().toISOString(),
      homeRelativeOnly: true,
      instanceId: options.instanceId,
    }),
  );

  return finishLocalFilesRun({
    message: `Indexed ${files.length} file${files.length === 1 ? "" : "s"} across ${
      directories.length
    } director${directories.length === 1 ? "y" : "ies"}.`,
    rawFiles,
    runId,
    state,
    status: files.length > 0 || warnings.length === 0 ? "success" : "error",
    warnings,
  });
}

async function finishLocalFilesRun({
  message,
  rawFiles,
  runId,
  state,
  status,
  warnings,
}: {
  message: string;
  rawFiles: string[];
  runId: string;
  state: Awaited<ReturnType<typeof readConnectorState>>;
  status: ConnectorIngestResult["status"];
  warnings: string[];
}): Promise<ConnectorIngestResult> {
  await writeConnectorState(
    "local-files",
    updateStateWithRun(state, {
      at: new Date().toISOString(),
      rawFiles,
      runId,
      status,
      warnings,
    }),
  );

  return {
    connectorId: "local-files",
    message,
    rawFiles,
    runId,
    statePath: `${openWikiConnectorsDisplayPath}/local-files/state.json`,
    status,
    warnings,
  };
}

/**
 * Depth-limited walk that records file metadata only. Contents are never read;
 * the manifest exists so agents can cite what is on disk without scanning it.
 */
async function walkDirectory(
  root: string,
  home: string,
  budget: { remaining: () => number },
): Promise<FileEntry[]> {
  if (budget.remaining() <= 0) return [];

  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: FileEntry[] = [];
  for (const entry of entries) {
    if (budget.remaining() <= 0) break;

    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_DIRECTORY_NAMES.has(entry.name)) continue;
      files.push(...(await walkDirectory(entryPath, home, budget)));
      continue;
    }
    if (!entry.isFile()) continue;

    const extension = path.extname(entry.name).toLowerCase();
    if (IGNORED_EXTENSIONS.has(extension)) continue;

    try {
      const stats = await stat(entryPath);
      files.push({
        bytes: stats.size,
        extension,
        modifiedAt: stats.mtime.toISOString(),
        path: toHomeRelativeDisplayPath(home, entryPath),
      });
    } catch {
      // The file disappeared mid-walk; skip it without failing the run.
    }
  }

  return files;
}

/**
 * Renders paths relative to the user's home so raw dumps never contain
 * absolute home paths while still naming the top-level directory.
 */
function toHomeRelativeDisplayPath(home: string, filePath: string): string {
  const relative = path.relative(home, filePath);

  return relative.split(path.sep).join("/");
}

function normalizeMaxFiles(maxFiles: number | undefined): number {
  const limit =
    typeof maxFiles === "number" && Number.isFinite(maxFiles) ? maxFiles : 500;

  return Math.max(1, Math.min(5000, Math.trunc(limit)));
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
