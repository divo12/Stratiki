import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { HostIntegrationInstaller } from "../../src/integrations/install/installer.js";
import { listHostTargets } from "../../src/integrations/install/registry.js";
import type { HostTargetId } from "../../src/integrations/install/types.js";

const tempDirs: string[] = [];

async function createProject(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "stratiki-migration-"));
  tempDirs.push(dir);
  execFileSync("git", ["init", "--quiet", dir]);
  return dir;
}

function legacyReceipt(target: HostTargetId): string {
  return `${JSON.stringify(
    {
      files: {},
      mcpServerCommand: {
        args: ["mcp", "--host", target],
        command: "openwiki",
      },
      package: "openwiki",
      target,
      version: "0.3.2",
    },
    null,
    2,
  )}\n`;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })),
  );
});

describe("legacy openwiki integration migration", () => {
  test("install replaces a legacy codex TOML block and skill dir without force", async () => {
    const root = await createProject();
    const configPath = path.join(root, ".codex", "config.toml");
    await mkdir(path.dirname(configPath), { recursive: true });
    // A pre-rename install: legacy markers, legacy table, legacy command.
    await writeFile(
      configPath,
      `model = "gpt-5"\n\n# OPENWIKI:MCP:START\n[mcp_servers.openwiki]\ncommand = "openwiki"\nargs = ["mcp", "--host", "codex"]\n# OPENWIKI:MCP:END\n`,
      "utf8",
    );

    const legacySkillDir = path.join(root, ".agents", "skills", "openwiki");
    await mkdir(legacySkillDir, { recursive: true });
    await writeFile(
      path.join(legacySkillDir, ".openwiki-install.json"),
      legacyReceipt("codex"),
      "utf8",
    );

    const installer = new HostIntegrationInstaller();
    const target = listHostTargets().find((t) => t.id === "codex")!;

    const result = await installer.install(target, {
      scope: "project",
      root,
    });
    expect(result.changed).toBe(true);

    // Legacy artifacts are gone; new ones are present and single.
    const config = await readFile(configPath, "utf8");
    expect(config).toContain("[mcp_servers.stratiki]");
    expect(config).not.toContain("[mcp_servers.openwiki]");
    expect(config).not.toContain("OPENWIKI:MCP");
    await expect(accessGone(legacySkillDir)).resolves.toBeUndefined();

    const statusAfter = await installer.status(target, {
      scope: "project",
      root,
    });
    expect(statusAfter).toBe("installed");

    // Uninstall cleans the migrated state completely.
    await installer.uninstall(target, { scope: "project", root });
    const afterUninstall = await readFile(configPath, "utf8");
    expect(afterUninstall).not.toContain("mcp_servers.stratiki");
  });

  test("install migrates a legacy claude JSON entry and removes the dead server", async () => {
    const root = await createProject();
    const configPath = path.join(root, ".mcp.json");
    await writeFile(
      configPath,
      `${JSON.stringify({
        mcpServers: {
          openwiki: { args: ["mcp", "--host", "claude"], command: "openwiki" },
        },
      })}\n`,
      "utf8",
    );

    const installer = new HostIntegrationInstaller();
    const target = listHostTargets().find((t) => t.id === "claude")!;
    await installer.install(target, { scope: "project", root });

    const parsed = JSON.parse(await readFile(configPath, "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(parsed.mcpServers.stratiki).toBeDefined();
    expect(parsed.mcpServers.openwiki).toBeUndefined();

    await installer.uninstall(target, { scope: "project", root });
    const cleaned = JSON.parse(await readFile(configPath, "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(cleaned.mcpServers.stratiki).toBeUndefined();
    expect(cleaned.mcpServers.openwiki).toBeUndefined();
  });

  test("foreign openwiki-named content is left untouched and still conflicts", async () => {
    const root = await createProject();
    const configPath = path.join(root, ".mcp.json");
    await writeFile(
      configPath,
      `${JSON.stringify({
        mcpServers: {
          openwiki: { command: "totally-custom", args: [] },
        },
      })}\n`,
      "utf8",
    );

    const installer = new HostIntegrationInstaller();
    const target = listHostTargets().find((t) => t.id === "claude")!;
    await installer.install(target, { scope: "project", root });

    const parsed = JSON.parse(await readFile(configPath, "utf8")) as {
      mcpServers: Record<string, { command?: string } | undefined>;
    };
    // Foreign entry preserved alongside our managed one.
    expect(parsed.mcpServers.openwiki?.command).toBe("totally-custom");
    expect(parsed.mcpServers.stratiki).toBeDefined();
  });

  test("a foreign skill directory at the legacy name is never removed", async () => {
    const root = await createProject();
    const legacySkillDir = path.join(root, ".agents", "skills", "openwiki");
    await mkdir(legacySkillDir, { recursive: true });
    // No receipt at all: not ours.
    await writeFile(path.join(legacySkillDir, "SKILL.md"), "# foreign", "utf8");

    const installer = new HostIntegrationInstaller();
    const target = listHostTargets().find((t) => t.id === "codex")!;
    await installer.install(target, { scope: "project", root });

    // Foreign directory survives; stratiki installed beside it.
    await expect(
      readFile(path.join(legacySkillDir, "SKILL.md"), "utf8"),
    ).resolves.toBe("# foreign");
    await expect(
      readFile(
        path.join(root, ".agents", "skills", "stratiki", "SKILL.md"),
        "utf8",
      ),
    ).resolves.toBeDefined();
  });
});

async function accessGone(targetPath: string): Promise<void> {
  try {
    await readFile(path.join(targetPath), "utf8");
    throw new Error(`expected ${targetPath} to be removed`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}
