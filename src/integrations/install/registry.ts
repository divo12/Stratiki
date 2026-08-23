import type {
  HostMcpServerCommand,
  HostTarget,
  HostTargetId,
} from "./types.js";

/**
 * Complete immutable registry of supported host installation targets.
 */
export const HOST_TARGETS = {
  codex: {
    id: "codex",
    displayName: "Codex",
    producerActor: "codex",
    user: {
      skillDirectory: ".agents/skills/stratiki",
      mcpConfig: {
        kind: "codex-toml",
        relativePath: ".codex/config.toml",
      },
    },
    project: {
      skillDirectory: ".agents/skills/stratiki",
      mcpConfig: {
        kind: "codex-toml",
        relativePath: ".codex/config.toml",
      },
    },
    documentationUrl: "https://learn.chatgpt.com/docs/extend/mcp",
  },
  claude: {
    id: "claude",
    displayName: "Claude Code",
    producerActor: "claude-code",
    user: {
      skillDirectory: ".claude/skills/stratiki",
      mcpConfig: { kind: "json", relativePath: ".claude.json" },
    },
    project: {
      skillDirectory: ".claude/skills/stratiki",
      mcpConfig: { kind: "json", relativePath: ".mcp.json" },
    },
    documentationUrl: "https://docs.anthropic.com/en/docs/claude-code/mcp",
  },
  cursor: {
    id: "cursor",
    displayName: "Cursor",
    producerActor: "cursor",
    user: {
      skillDirectory: ".cursor/skills/stratiki",
      mcpConfig: { kind: "json", relativePath: ".cursor/mcp.json" },
    },
    project: {
      skillDirectory: ".cursor/skills/stratiki",
      mcpConfig: { kind: "json", relativePath: ".cursor/mcp.json" },
    },
    documentationUrl: "https://cursor.com/docs/mcp",
  },
  antigravity: {
    id: "antigravity",
    displayName: "Antigravity",
    producerActor: "antigravity",
    user: {
      skillDirectory: ".gemini/antigravity-cli/skills/stratiki",
      mcpConfig: {
        kind: "json",
        relativePath: ".gemini/config/mcp_config.json",
      },
    },
    project: {
      skillDirectory: ".agents/skills/stratiki",
      mcpConfig: { kind: "json", relativePath: ".agents/mcp_config.json" },
    },
    documentationUrl: "https://antigravity.google/docs/mcp/",
  },
  opencode: {
    id: "opencode",
    displayName: "OpenCode",
    producerActor: "opencode",
    user: {
      skillDirectory: ".config/opencode/skills/stratiki",
      mcpConfig: {
        kind: "opencode-json",
        relativePath: ".config/opencode/opencode.json",
      },
    },
    project: {
      skillDirectory: ".opencode/skills/stratiki",
      mcpConfig: { kind: "opencode-json", relativePath: "opencode.json" },
    },
    documentationUrl: "https://opencode.ai/docs/mcp-servers/",
  },
} as const satisfies Record<HostTargetId, HostTarget>;

/**
 * Resolves a host registry entry from untrusted CLI text.
 *
 * @param id - Candidate host identifier.
 * @returns Matching host target, or `undefined` when unsupported.
 */
export function getHostTarget(id: string): HostTarget | undefined {
  return HOST_TARGETS[id as HostTargetId];
}

/**
 * Lists supported host targets in registry order.
 *
 * @returns Independent array of host registry entries.
 */
export function listHostTargets(): HostTarget[] {
  return Object.values(HOST_TARGETS);
}

/**
 * Creates the default managed MCP command for one host.
 *
 * @param target - Stable host identifier passed to the MCP process.
 * @returns Portable executable invocation used by published installations.
 */
export function defaultMcpServerCommand(
  target: HostTargetId,
): HostMcpServerCommand {
  return {
    command: "stratiki",
    args: ["mcp", "--host", target],
  };
}
