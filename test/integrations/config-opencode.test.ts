import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  getOpenCodeMcpEntryStatus,
  installOpenCodeMcpEntry,
  uninstallOpenCodeMcpEntry,
} from "../../src/integrations/install/config-opencode.ts";
import type {
  HostIntegrationStatus,
  HostMcpServerCommand,
} from "../../src/integrations/install/types.ts";

const ENTRY: HostMcpServerCommand = {
  command: "stratiki",
  args: ["mcp", "--host", "opencode"],
};
const MANAGED_ENTRY = {
  type: "local",
  command: ["stratiki", "mcp", "--host", "opencode"],
  enabled: true,
};
const temporaryRoots: string[] = [];

/**
 * Creates one isolated adapter-test directory.
 *
 * @returns Absolute temporary directory path.
 */
async function createRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-config-"));
  temporaryRoots.push(root);
  return root;
}

/**
 * Reads a config as parsed JSON with its exact bytes.
 *
 * @param filePath - Absolute config path.
 * @returns Parsed unknown content.
 */
async function readConfig(filePath: string): Promise<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(await readFile(filePath, "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Expected a JSON object.");
  }
  return parsed;
}

/**
 * Asserts the current managed-entry status for a seeded config.
 *
 * @param filePath - Absolute config path.
 * @param expected - Expected managed-entry state.
 */
async function expectStatus(
  filePath: string,
  expected: HostIntegrationStatus,
): Promise<void> {
  expect(await getOpenCodeMcpEntryStatus(filePath, ENTRY)).toBe(expected);
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("OpenCode MCP config ownership", () => {
  test("creates, preserves, recognizes, and removes the exact entry", async () => {
    const root = await createRoot();
    const filePath = path.join(root, "opencode.json");
    await writeFile(
      filePath,
      `${JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        mcp: {
          other: { type: "local", command: ["other"], enabled: true },
        },
      })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    await chmod(filePath, 0o600);

    await expect(installOpenCodeMcpEntry(filePath, ENTRY)).resolves.toBe(true);

    const installed = await readConfig(filePath);
    expect(installed.$schema).toBe("https://opencode.ai/config.json");
    expect(installed.mcp).toMatchObject({
      other: { type: "local", command: ["other"], enabled: true },
      stratiki: MANAGED_ENTRY,
    });
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    await expectStatus(filePath, "installed");

    await expect(installOpenCodeMcpEntry(filePath, ENTRY)).resolves.toBe(false);
    await expectStatus(filePath, "installed");

    await expect(uninstallOpenCodeMcpEntry(filePath, ENTRY)).resolves.toBe(
      true,
    );
    const removed = await readConfig(filePath);
    expect(removed.mcp).toMatchObject({
      other: { type: "local", command: ["other"], enabled: true },
    });
    await expect(uninstallOpenCodeMcpEntry(filePath, ENTRY)).resolves.toBe(
      false,
    );
    await expectStatus(filePath, "not-installed");
  });

  test("creates a missing config with only the managed entry", async () => {
    const root = await createRoot();
    const filePath = path.join(root, ".config", "opencode.json");

    await expect(installOpenCodeMcpEntry(filePath, ENTRY)).resolves.toBe(true);
    expect(await readConfig(filePath)).toEqual({
      mcp: { stratiki: MANAGED_ENTRY },
    });
    await expectStatus(filePath, "installed");
  });

  test("treats property order as irrelevant but rejects shape drift", async () => {
    const root = await createRoot();
    const filePath = path.join(root, "opencode.json");

    const variants: Record<string, unknown>[] = [
      { ...MANAGED_ENTRY },
      { enabled: true, command: [...MANAGED_ENTRY.command], type: "local" },
      { ...MANAGED_ENTRY, extra: true },
      { type: "local", command: [...MANAGED_ENTRY.command] },
      { ...MANAGED_ENTRY, enabled: false },
      { type: "remote", command: [...MANAGED_ENTRY.command], enabled: true },
      { type: "local", command: ["custom"], enabled: true },
    ];

    for (const [index, variant] of variants.entries()) {
      await writeFile(
        filePath,
        `${JSON.stringify({ mcp: { stratiki: variant } })}\n`,
      );
      const expected: HostIntegrationStatus =
        index < 2 ? "installed" : "modified";
      await expectStatus(filePath, expected);
    }
  });

  test("rejects malformed JSON without changing bytes", async () => {
    const root = await createRoot();
    const filePath = path.join(root, "opencode.json");
    const malformed = "{ malformed json\n";
    await writeFile(filePath, malformed, "utf8");

    await expect(installOpenCodeMcpEntry(filePath, ENTRY)).rejects.toThrow(
      /malformed JSON/u,
    );
    await expect(uninstallOpenCodeMcpEntry(filePath, ENTRY)).rejects.toThrow(
      /malformed JSON/u,
    );
    expect(await readFile(filePath, "utf8")).toBe(malformed);
    await expectStatus(filePath, "modified");
  });

  test("replaces only an explicitly recognized prior entry", async () => {
    const root = await createRoot();
    const filePath = path.join(root, "opencode.json");
    const prior: HostMcpServerCommand = {
      command: "node",
      args: ["dist/cli/cli.js", "mcp", "--host", "opencode"],
    };
    await writeFile(
      filePath,
      `${JSON.stringify({
        mcp: {
          stratiki: {
            type: "local",
            command: [prior.command, ...prior.args],
            enabled: true,
          },
        },
      })}\n`,
    );

    await expect(installOpenCodeMcpEntry(filePath, ENTRY)).rejects.toThrow(
      /already exists/u,
    );
    await expect(installOpenCodeMcpEntry(filePath, ENTRY, prior)).resolves.toBe(
      true,
    );
    expect(await readConfig(filePath)).toMatchObject({
      mcp: { stratiki: MANAGED_ENTRY },
    });
    await expectStatus(filePath, "installed");

    await expect(uninstallOpenCodeMcpEntry(filePath, ENTRY)).resolves.toBe(
      true,
    );
    await expectStatus(filePath, "not-installed");
  });
});
