import { createHash } from "node:crypto";
import { lstat, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OPENWIKI_VERSION } from "../../version.js";
import type {
  HostIntegrationStatus,
  HostMcpServerCommand,
  HostTarget,
  HostTargetId,
} from "./types.js";

const RECEIPT_FILE = ".stratiki-install.json";
const ALLOWED_BUNDLE_ROOTS = new Set(["SKILL.md", "agents", "references"]);

/**
 * Ownership receipt stored inside one installed skill directory.
 */
export interface SkillReceipt {
  /**
   * Package that owns the installed files.
   */
  package: "stratiki";

  /**
   * OpenWiki package version that produced the installation.
   */
  version: string;

  /**
   * Host target that owns the destination directory.
   */
  target: HostTargetId;

  /**
   * Exact MCP server invocation installed alongside the skill.
   */
  mcpServerCommand: HostMcpServerCommand;

  /**
   * SHA-256 hashes keyed by installed relative path.
   */
  files: Record<string, string>;
}

/**
 * Deterministic inventory of one canonical or installed skill directory.
 */
export interface SkillInventory {
  /**
   * SHA-256 hashes keyed by portable relative file path.
   */
  files: Record<string, string>;
}

/**
 * Inspection result for one skill destination.
 */
export interface InstallationInspection {
  /**
   * Current ownership and integrity state.
   */
  status: HostIntegrationStatus;

  /**
   * Validated receipt for an intact managed installation.
   *
   * @default undefined - the destination is absent or modified.
   */
  receipt?: SkillReceipt;
}

/**
 * Resolves the canonical host skill from a source or built installer module.
 *
 * @param moduleUrl - Source or built installer module URL.
 * @returns Absolute canonical skill bundle path.
 */
export function resolveCanonicalSkillBundle(moduleUrl: string): string {
  const packageRoot = path.resolve(
    path.dirname(fileURLToPath(moduleUrl)),
    "../../../",
  );
  return path.join(packageRoot, "integrations", "stratiki");
}

/**
 * Inventories and validates one canonical or installed skill directory.
 *
 * @param directory - Skill directory to inspect.
 * @param allowReceipt - Whether the managed receipt may exist at the root.
 * @returns Deterministic relative-path hash inventory.
 */
export async function inventorySkill(
  directory: string,
  allowReceipt: boolean,
): Promise<SkillInventory> {
  const root = await lstat(directory);
  if (!root.isDirectory() || root.isSymbolicLink()) {
    throw new Error("The OpenWiki skill bundle must be a real directory.");
  }

  const files: Record<string, string> = {};
  await walk(directory, "");
  if (!Object.hasOwn(files, "SKILL.md")) {
    throw new Error("The OpenWiki skill bundle is missing SKILL.md.");
  }
  return { files };

  /**
   * Recursively visits regular files below the skill root.
   *
   * @param current - Absolute directory currently being inspected.
   * @param relativeDirectory - Portable relative directory path.
   */
  async function walk(
    current: string,
    relativeDirectory: string,
  ): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relative = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      const topLevel = relative.split("/", 1)[0];
      if (relative === RECEIPT_FILE && allowReceipt && !entry.isDirectory()) {
        continue;
      }
      if (!topLevel || !ALLOWED_BUNDLE_ROOTS.has(topLevel)) {
        throw new Error(`Unexpected OpenWiki skill path: ${relative}`);
      }
      if (topLevel === "SKILL.md" && relative !== "SKILL.md") {
        throw new Error(`Unexpected OpenWiki skill path: ${relative}`);
      }

      const absolute = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(
          `OpenWiki skill symlinks are not supported: ${relative}`,
        );
      }
      if (entry.isDirectory()) {
        if (relative === "SKILL.md") {
          throw new Error("SKILL.md must be a regular file.");
        }
        await walk(absolute, relative);
      } else if (entry.isFile()) {
        if (relative === "agents" || relative === "references") {
          throw new Error(
            `OpenWiki skill path must be a directory: ${relative}`,
          );
        }
        files[relative] = createHash("sha256")
          .update(await readFile(absolute))
          .digest("hex");
      } else {
        throw new Error(
          `OpenWiki skill special files are not supported: ${relative}`,
        );
      }
    }
  }
}

/**
 * Writes a deterministic ownership receipt into a staged skill.
 *
 * @param directory - Staged skill directory.
 * @param target - Registry host owning the destination.
 * @param files - Canonical file hashes copied into staging.
 * @param mcpServerCommand - Exact MCP server invocation installed with the skill.
 */
export async function writeReceipt(
  directory: string,
  target: HostTargetId,
  files: Record<string, string>,
  mcpServerCommand: HostMcpServerCommand,
): Promise<void> {
  const receipt: SkillReceipt = {
    package: "stratiki",
    version: OPENWIKI_VERSION,
    target,
    mcpServerCommand,
    files,
  };
  await writeFile(
    path.join(directory, RECEIPT_FILE),
    `${JSON.stringify(receipt, null, 2)}\n`,
    "utf8",
  );
}

/**
 * Inspects ownership and exact content integrity for one destination.
 *
 * @param directory - Host-owned skill destination.
 * @param target - Host expected by the receipt.
 * @returns Absent, intact, or modified state and any valid receipt.
 */
export async function inspectInstallation(
  directory: string,
  target: HostTargetId,
): Promise<InstallationInspection> {
  try {
    const root = await lstat(directory);
    if (!root.isDirectory() || root.isSymbolicLink()) {
      return { status: "modified" };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { status: "not-installed" };
    }
    throw error;
  }

  try {
    const receipt = await readReceipt(directory, target);
    const inventory = await inventorySkill(directory, true);
    if (!sameFiles(receipt.files, inventory.files)) {
      return { status: "modified" };
    }
    return { status: "installed", receipt };
  } catch {
    return { status: "modified" };
  }
}

/**
 * Compares two deterministic file-hash maps.
 *
 * @param left - First inventory.
 * @param right - Second inventory.
 * @returns Whether both contain exactly the same paths and hashes.
 */
export function sameFiles(
  left: Record<string, string>,
  right: Record<string, string>,
): boolean {
  const leftEntries = Object.entries(left);
  const rightEntries = Object.entries(right);
  return (
    leftEntries.length === rightEntries.length &&
    leftEntries.every(([file, hash]) => right[file] === hash)
  );
}

/**
 * Reads and strictly validates one managed ownership receipt.
 *
 * @param directory - Installed skill directory.
 * @param target - Expected registry host.
 * @returns Validated ownership receipt.
 */
async function readReceipt(
  directory: string,
  target: HostTargetId,
): Promise<SkillReceipt> {
  const parsed: unknown = JSON.parse(
    await readFile(path.join(directory, RECEIPT_FILE), "utf8"),
  );
  if (!isRecord(parsed)) throw new Error("Invalid skill receipt.");
  if (
    !hasExpectedReceiptKeys(parsed) ||
    parsed.package !== "stratiki" ||
    typeof parsed.version !== "string" ||
    !parsed.version ||
    parsed.target !== target ||
    !isHashRecord(parsed.files) ||
    !isMcpServerCommand(parsed.mcpServerCommand)
  ) {
    throw new Error("Invalid skill receipt.");
  }
  return {
    package: "stratiki",
    version: parsed.version,
    target,
    mcpServerCommand: parsed.mcpServerCommand,
    files: parsed.files,
  };
}

/**
 * Accepts only the current strict receipt shape.
 *
 * @param value - Parsed receipt object.
 * @returns Whether the object contains exactly the supported keys.
 */
function hasExpectedReceiptKeys(value: Record<string, unknown>): boolean {
  return (
    Object.keys(value).sort().join(",") ===
    "files,mcpServerCommand,package,target,version"
  );
}

/**
 * Validates an exact MCP server invocation.
 *
 * @param value - Candidate receipt field.
 * @returns Whether the value contains only a command and ordered arguments.
 */
function isMcpServerCommand(value: unknown): value is HostMcpServerCommand {
  if (!isRecord(value)) return false;
  return (
    Object.keys(value).sort().join(",") === "args,command" &&
    typeof value.command === "string" &&
    value.command.trim().length > 0 &&
    Array.isArray(value.args) &&
    value.args.every((argument) => typeof argument === "string")
  );
}

/**
 * Narrows an unknown value to a valid portable path-to-hash map.
 *
 * @param value - Unknown receipt `files` field.
 * @returns Whether every key and SHA-256 value is valid.
 */
function isHashRecord(value: unknown): value is Record<string, string> {
  if (!isRecord(value)) return false;
  return Object.entries(value).every(([relative, hash]) => {
    const normalized = relative.split("/").join(path.sep);
    return (
      relative !== RECEIPT_FILE &&
      !path.isAbsolute(relative) &&
      !relative.split("/").includes("..") &&
      resolvePortableRoot(relative) !== undefined &&
      path.normalize(normalized) === normalized &&
      typeof hash === "string" &&
      /^[a-f0-9]{64}$/u.test(hash)
    );
  });
}

/**
 * Resolves the allowed top-level bundle root for a portable receipt path.
 *
 * @param relative - Slash-delimited receipt path.
 * @returns Allowed root name, or `undefined` when disallowed.
 */
function resolvePortableRoot(relative: string): string | undefined {
  const root = relative.split("/", 1)[0];
  return root && ALLOWED_BUNDLE_ROOTS.has(root) ? root : undefined;
}

/**
 * Narrows an unknown value to a non-array object.
 *
 * @param value - Unknown parsed JSON value.
 * @returns Whether the value is a record.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Directory name used by pre-rename installations. */
const LEGACY_SKILL_DIR_NAME = "openwiki";
/** Receipt filename written by pre-rename installations. */
const LEGACY_RECEIPT_FILE = ".openwiki-install.json";

/**
 * Removes a pre-rename managed installation (skills/openwiki with a valid
 * `.openwiki-install.json` receipt for this host). Foreign directories are
 * left untouched so the existing force/conflict flow keeps protecting them.
 *
 * @param target - Registry entry whose legacy install is claimed.
 * @param context - Resolved install context carrying the new destination.
 * @returns Whether a legacy directory was removed.
 */
export async function removeLegacySkillInstallation(
  target: HostTarget,
  context: { skillDirectory: string },
): Promise<boolean> {
  const legacyDir = path.join(
    path.dirname(context.skillDirectory),
    LEGACY_SKILL_DIR_NAME,
  );
  let receiptRaw: string;
  try {
    receiptRaw = await readFile(
      path.join(legacyDir, LEGACY_RECEIPT_FILE),
      "utf8",
    );
  } catch {
    return false;
  }

  try {
    const parsed: unknown = JSON.parse(receiptRaw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "package" in parsed &&
      "target" in parsed &&
      (parsed as { package?: unknown }).package === "openwiki" &&
      (parsed as { target?: unknown }).target === target.id
    ) {
      await rm(legacyDir, { recursive: true, force: true });
      return true;
    }
  } catch {
    // Unreadable or malformed legacy receipt: treat as foreign and keep it.
  }

  return false;
}
