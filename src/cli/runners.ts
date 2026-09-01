import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  configureAuthProvider,
  listAuthProviderTools,
  shouldDiscoverToolsAfterAuth,
} from "../auth/configure.js";
import { startNgrokTunnel } from "../auth/ngrok.js";
import { formatAuthProviderList, runOAuthAuth } from "../auth/oauth.js";
import { createOpenWikiThreadId, runOpenWikiAgent } from "../agent/index.js";
import type { OpenWikiRunEvent, OpenWikiRunOptions } from "../agent/types.js";
import { BOOK_SECTIONS } from "../book/types.js";
import { BOOK_MANIFEST_FILENAME, WorkspaceManifest } from "../book/manifest.js";
import { ContextIndex, renderPacket } from "../book/packet.js";
import { EpisodeStore, type EpisodeRecord } from "../book/episode-store.js";
import { BookLease } from "../book/lease.js";
import { planRefresh } from "../book/refresh-planner.js";
import { tierMaxAgeHours } from "../book/freshness.js";
import type { FreshnessTier } from "../book/types.js";
import { CONNECTOR_IDS, isConnectorId } from "../connectors/registry.js";
import {
  openWikiBookDbPath,
  openWikiHomeDir,
} from "../config/openwiki-home.js";
import { resolveConfiguredProvider } from "../config/constants.js";
import {
  ensureCodeModeRepoSetup,
  runCodeModeConnectors,
} from "../ingestion/code-mode.js";
import { runOpenWikiIngestion } from "../ingestion/ingestion.js";
import { getErrorMessage } from "../platform/diagnostics.js";
import {
  deleteConnectorSchedules,
  getSavedPowerScheduleStatus,
  listConnectorSchedules,
  pauseConnectorSchedules,
  resumeConnectorSchedules,
} from "../scheduling/schedules.js";
import {
  readOpenWikiOnboardingConfig,
  saveOpenWikiOnboardingConfig,
} from "../setup/onboarding.js";
import {
  withRunTelemetry,
  type RunTelemetryContext,
} from "../telemetry/index.js";
import { exportStaticVisualizer } from "../visualize/static-export.js";
import { runVisualizeServer } from "../visualize/server.js";
import type { CliCommand } from "./commands.js";
import { isDebugMode } from "./debug.js";
import { getAuthFix, getAuthFixSteps } from "./diagnostics/auth-fix.js";
import { getErrorDiagnostics } from "./diagnostics/error-diagnostics.js";
import { getRunModeCwd, getRunModeOutputMode } from "./run-mode.js";
import {
  formatPowerScheduleStatus,
  formatScheduleHeader,
  formatScheduleMutationResult,
  formatScheduleStatus,
} from "./schedule-format.js";

export async function runNgrokCommand(
  command: Extract<CliCommand, { kind: "ngrok" }>,
): Promise<void> {
  try {
    await startNgrokTunnel({
      port: command.port,
      url: command.url,
    });
    process.exitCode = 0;
  } catch (error) {
    process.stderr.write(`${getErrorMessage(error)}\n`);
    process.exitCode = 1;
  }
}

/**
 * Start the wiki visualizer server or export its static files for web hosting.
 */
export async function runVisualizeCommand(
  command: Extract<CliCommand, { kind: "visualize" }>,
): Promise<void> {
  const wikiRoot = path.resolve(process.cwd(), command.wikiDir);
  try {
    if (command.exportDir) {
      const result = await exportStaticVisualizer({
        wikiRoot,
        outputDir: path.resolve(process.cwd(), command.exportDir),
      });
      process.stdout.write(
        `Exported static visualizer to ${result.outputDir} (${result.graph.nodes.length} pages, ${result.graph.edges.length} links).\n`,
      );
      return;
    }

    await runVisualizeServer({
      wikiRoot,
      port: command.port,
      open: command.open,
    });
  } catch (error) {
    process.stderr.write(`${getErrorMessage(error)}\n`);
    process.exitCode = 1;
  }
}

export async function runCronCommand(
  command: Extract<CliCommand, { kind: "cron" }>,
): Promise<void> {
  try {
    const config = await readOpenWikiOnboardingConfig();

    if (command.action !== "list") {
      if (!command.target) {
        throw new Error(`Target is required for cron ${command.action}.`);
      }

      const result =
        command.action === "pause"
          ? await pauseConnectorSchedules(config, command.target)
          : command.action === "resume"
            ? await resumeConnectorSchedules({
                config,
                cwd: process.cwd(),
                target: command.target,
              })
            : await deleteConnectorSchedules(config, command.target);

      await saveOpenWikiOnboardingConfig(result.config);
      process.stdout.write(
        formatScheduleMutationResult(command.action, result),
      );
      await printCronSchedules(result.config);
      process.exitCode = 0;
      return;
    }

    await printCronSchedules(config);
    process.exitCode = 0;
  } catch (error) {
    process.stderr.write(`${getErrorMessage(error)}\n`);
    process.exitCode = 1;
  }
}

async function printCronSchedules(
  config: Awaited<ReturnType<typeof readOpenWikiOnboardingConfig>>,
): Promise<void> {
  const schedules = await listConnectorSchedules(config);
  const powerSchedule = getSavedPowerScheduleStatus(config);

  process.stdout.write(formatScheduleHeader(schedules.length));
  process.stdout.write(formatPowerScheduleStatus(powerSchedule));

  if (schedules.length === 0) {
    process.stdout.write("No connector schedules are configured.\n");
    return;
  }

  for (const schedule of schedules) {
    process.stdout.write(formatScheduleStatus(schedule));
  }
}

export async function runIngestCommand(
  command: Extract<CliCommand, { kind: "ingest" }>,
): Promise<void> {
  try {
    const result = await runOpenWikiIngestion(process.cwd(), {
      debug: isDebugMode(),
      modelId: command.modelId,
      scheduledOnly: command.scheduledOnly,
      target: command.target,
      onEvent: (event) => {
        if (event.type === "text") {
          process.stdout.write(event.text);
        }
      },
    });

    process.stdout.write("\nIngestion summary\n");
    for (const sourceResult of result.results) {
      process.stdout.write(
        `- ${sourceResult.displayName}: ${sourceResult.status}; ${sourceResult.rawFiles.length} raw file(s)\n`,
      );
    }

    const hadError = result.results.some(
      (sourceResult) => sourceResult.status === "error",
    );

    process.exitCode = hadError ? 1 : 0;
  } catch (error) {
    process.stderr.write(`${getErrorMessage(error)}\n`);
    writePrintErrorDiagnostics(error);
    process.exitCode = 1;
  }
}

export async function runAuthCommand(
  command: Extract<CliCommand, { kind: "auth" }>,
): Promise<void> {
  try {
    if (command.action === "list") {
      process.stdout.write(`${formatAuthProviderList()}\n`);
    } else {
      if (command.provider === null) {
        throw new Error("Auth provider is required.");
      }

      if (command.action === "configure") {
        const result = await configureAuthProvider(command.provider, {
          force: command.force,
        });
        process.stdout.write(
          `${result.status === "exists" ? "Config already exists" : `Config ${result.status}`}: ${result.configPath}\n`,
        );
        for (const nextStep of result.nextSteps) {
          process.stdout.write(`- ${nextStep}\n`);
        }
      } else if (command.action === "tools") {
        const result = await listAuthProviderTools(command.provider);
        process.stdout.write(
          `Tools for ${result.provider} (${result.configPath})\n`,
        );
        process.stdout.write(`Wrote discovery: ${result.rawFile}\n`);
        process.stdout.write(`${JSON.stringify(result.tools, null, 2)}\n`);
      } else {
        const result = await runOAuthAuth(command.provider);
        process.stdout.write(
          `Saved ${result.provider} auth values: ${result.savedEnvKeys.join(", ")}\n`,
        );
        const configureResult = await configureAuthProvider(command.provider, {
          force: command.force,
        });
        process.stdout.write(
          `${configureResult.status === "exists" ? "Config already exists" : `Config ${configureResult.status}`}: ${configureResult.configPath}\n`,
        );
        for (const nextStep of configureResult.nextSteps) {
          process.stdout.write(`- ${nextStep}\n`);
        }

        if (shouldDiscoverToolsAfterAuth(command.provider)) {
          try {
            const toolsResult = await listAuthProviderTools(command.provider);
            process.stdout.write(
              `Discovered ${toolsResult.tools.length} MCP tool(s); wrote ${toolsResult.rawFile}\n`,
            );
            const toolNames = toolsResult.tools
              .map((tool) => tool.name)
              .slice(0, 20);
            if (toolNames.length > 0) {
              process.stdout.write(`Tools: ${toolNames.join(", ")}\n`);
            }
          } catch (error) {
            process.stdout.write(
              `MCP tool discovery skipped: ${getErrorMessage(error)}\n`,
            );
          }
        }
      }
    }

    process.exitCode = 0;
  } catch (error) {
    process.stderr.write(`${getErrorMessage(error)}\n`);
    process.exitCode = 1;
  }
}

/**
 * Builds the telemetry context for a run from the parsed command. Flag names
 * only, never argument values.
 */
export async function runPrintCommand(
  command: Extract<CliCommand, { kind: "run" }>,
): Promise<void> {
  try {
    const output: string[] = [];

    const runtimeCwd = getRunModeCwd(command.mode);
    const runtimeOutputMode = getRunModeOutputMode(command.mode);

    const handlePrintEvent = (event: OpenWikiRunEvent): void => {
      if (event.type === "text") {
        output.push(event.text);
      }
    };

    const runOptions: OpenWikiRunOptions = {
      debug: isDebugMode(),
      isFollowup: command.command === "chat",
      language: command.language,
      modelId: command.modelId,
      outputMode: runtimeOutputMode,
      threadId: createOpenWikiThreadId(runtimeCwd),
      telemetryFile: command.telemetryFile ?? undefined,
      onEvent: handlePrintEvent,
    };

    // withRunTelemetry is the single boundary that records this run, wrapping repo
    // setup and the connector pull as well as the agent so a throw in either
    // pre-agent step is recorded rather than only surfaced on stderr below.
    const telemetryContext: RunTelemetryContext = {};

    await withRunTelemetry(
      command.command,
      runOptions,
      telemetryContext,
      async () => {
        if (command.mode === "code") {
          await ensureCodeModeRepoSetup(runtimeCwd, {
            createWorkflow: command.command === "init",
          });
        }

        // Code-mode connectors (e.g. langsmith) pull their evidence and augment
        // the agent message before the run, so --print behaves exactly like
        // interactive.
        const userMessage =
          command.mode === "code" && command.command !== "chat"
            ? await runCodeModeConnectors(
                runtimeCwd,
                command.userMessage ?? undefined,
                handlePrintEvent,
              )
            : command.userMessage;

        await runOpenWikiAgent(
          command.command,
          runtimeCwd,
          { ...runOptions, userMessage },
          telemetryContext,
        );
      },
    );

    const text = output.join("").trim();

    if (text.length > 0) {
      process.stdout.write(`${text}\n`);
    }

    process.exitCode = 0;
  } catch (error) {
    const message = getErrorMessage(error);
    process.stderr.write(`${message}\n`);
    writePrintAuthFix(error, message);
    writePrintErrorDiagnostics(error);
    process.exitCode = 1;
  }
}

/**
 * Write the concise auth "how to fix" guidance to stderr on a non-interactive
 * failure, mirroring the interactive panel so CI/print runs get the same help.
 * No-op unless the failure looks like an auth error. Key names only.
 */
export function writePrintAuthFix(error: unknown, message: string): void {
  const authFix = getAuthFix(error, message, resolveConfiguredProvider());

  if (!authFix) {
    return;
  }

  process.stderr.write("\nHow to fix\n");
  process.stderr.write(
    "Your provider rejected the credentials for this run.\n",
  );

  getAuthFixSteps(authFix).forEach((step, index) => {
    process.stderr.write(`${index + 1}. ${step}\n`);
  });

  process.stderr.write("For full detail, re-run with --debug.\n");
}

export function writePrintErrorDiagnostics(error: unknown): void {
  const diagnostics = getErrorDiagnostics(error);

  if (diagnostics.length === 0) {
    return;
  }

  process.stderr.write("\nError Diagnostics\n");

  for (const diagnostic of diagnostics) {
    process.stderr.write(`${diagnostic.label}: ${diagnostic.value}\n`);
  }
}

/**
 * Dispatches `stratiki book` subcommands: init, status, refresh, context.
 */
export async function runBookCommand(
  command: Extract<CliCommand, { kind: "book" }>,
): Promise<void> {
  const bookDir = path.join(process.cwd(), "openwiki");

  if (command.action === "init") {
    await initBookManifest(bookDir, command);
    return;
  }
  if (command.action === "status") {
    await printBookStatus(bookDir);
    return;
  }
  if (command.action === "context") {
    await printBookContext(bookDir, command.query ?? "");
    return;
  }

  await refreshBook(bookDir);
}

/**
 * Dispatches `stratiki strategy` subcommands: seed, list.
 */
export async function runStrategyCommand(
  command: Extract<CliCommand, { kind: "strategy" }>,
): Promise<void> {
  const { parseDecisionSeed } = await import("../strategy/parser.js");
  const { decomposeDecision } = await import("../strategy/decomposer.js");
  const { FileStrategyStore } = await import("../strategy/store.js");
  const { openWikiStrategyDir } = await import(
    "../config/openwiki-home.js"
  );
  const bookDir = path.join(process.cwd(), "openwiki");
  const store = new FileStrategyStore(openWikiStrategyDir);

  if (command.action === "list") {
    const decisions = await store.listDecisions();
    if (decisions.length === 0) {
      process.stdout.write("No decisions seeded yet.\n");
      return;
    }

    process.stdout.write(`Decisions (${decisions.length}):\n`);
    for (const decision of decisions) {
      const goals = await store.getGoalsForDecision(decision.id);
      process.stdout.write(
        `\n${decision.id}: ${decision.description}\n  Status: ${decision.status}\n  Goals: ${goals.length}\n`,
      );
    }
    return;
  }

  if (command.description === null) {
    process.stderr.write("Description is required for seed action.\n");
    process.exitCode = 1;
    return;
  }

  const decision = parseDecisionSeed({ description: command.description });
  const index = await ContextIndex.buildFromDirectory(bookDir);
  try {
    const result = decomposeDecision(decision, index);
    await store.saveDecision(result.decision);
    await store.saveGoals(result.goals);

    process.stdout.write(`Seeded decision: ${result.decision.id}\n`);
    process.stdout.write(`  ${result.decision.description}\n`);
    process.stdout.write(`\nGenerated ${result.goals.length} goal(s):\n`);

    const sortedGoals = [...result.goals].sort((a, b) => b.rank - a.rank);
    for (const goal of sortedGoals) {
      process.stdout.write(
        `\n- [rank ${goal.rank}] ${goal.description}\n  Grounded in: ${goal.groundedIn.length > 0 ? goal.groundedIn.join(", ") : "none"}\n`,
      );
    }
  } finally {
    index.close();
  }
}

async function initBookManifest(
  bookDir: string,
  command: Extract<CliCommand, { kind: "book" }>,
): Promise<void> {
  const manifestPath = path.join(bookDir, BOOK_MANIFEST_FILENAME);

  if (!command.force) {
    const exists = await manifestExists(manifestPath);
    if (exists) {
      process.stderr.write(
        `A book manifest already exists at ${manifestPath}. Use --force to replace it.\n`,
      );
      process.exitCode = 1;
      return;
    }
  }

  const workspaceName =
    command.name ?? path.basename(process.cwd()).replace(/[-_]+/gu, " ").trim();

  const manifest = WorkspaceManifest.createDefault(workspaceName);
  await manifest.save(manifestPath);

  process.stdout.write(`Created book manifest at ${manifestPath}\n`);
  process.stdout.write(`Workspace: ${manifest.name}\n`);
  const grouped = manifest.requirementsBySection();
  for (const sectionId of BOOK_SECTIONS) {
    const count = grouped[sectionId].length;
    process.stdout.write(
      `  ${sectionId}: ${count} coverage requirement${count === 1 ? "" : "s"}\n`,
    );
  }
}

/**
 * Prints episode-store counts plus per-source tier/staleness derived from
 * the workspace manifest.
 */
async function printBookStatus(bookDir: string): Promise<void> {
  const manifest = await loadManifestOrThrow(bookDir);
  const store = await EpisodeStore.open(openWikiBookDbPath);

  try {
    process.stdout.write(`Workspace: ${manifest.name}\n`);
    process.stdout.write(`Episodes stored: ${store.count()}\n`);

    const latestByConnector = new Map<string, EpisodeRecord>();
    for (const episode of store.listRecent(500)) {
      if (!latestByConnector.has(episode.connectorId)) {
        latestByConnector.set(episode.connectorId, episode);
      }
    }

    const now = new Date();
    for (const connectorId of CONNECTOR_IDS) {
      const tier = manifest.tierForConnector(connectorId);
      const latest = latestByConnector.get(connectorId);
      if (latest === undefined) {
        process.stdout.write(`  ${connectorId} [${tier}]: never pulled\n`);
        continue;
      }

      const ageHours =
        (now.getTime() - Date.parse(latest.ingestTimeIso)) / (60 * 60 * 1000);
      const staleMarker = ageHours >= tierMaxAgeHours(tier) ? " STALE" : "";
      process.stdout.write(
        `  ${connectorId} [${tier}]: last ingest ${latest.ingestTimeIso} (${ageHours.toFixed(1)}h ago)${staleMarker}\n`,
      );
    }
  } finally {
    store.close();
  }
}

/**
 * Plans the refresh from the episode store and runs ingestion for due
 * sources under a single-writer lease so concurrent refreshes cannot
 * interleave wiki edits.
 */
async function refreshBook(bookDir: string): Promise<void> {
  const leasePath = path.join(openWikiHomeDir, "refresh.lock");
  const lease = BookLease.at(leasePath);
  const acquired = await lease.acquire();

  if (acquired.outcome === "held-by-other") {
    process.stderr.write(
      `Another refresh holds the lease (owner ${acquired.holder.owner}, acquired ${acquired.holder.acquiredAtIso}).\n`,
    );
    process.exitCode = 1;
    return;
  }

  try {
    const manifest = await loadManifestOrThrow(bookDir);
    const latestByConnector = new Map<string, EpisodeRecord>();
    const store = await EpisodeStore.open(openWikiBookDbPath);
    try {
      for (const episode of store.listRecent(1000)) {
        if (!latestByConnector.has(episode.connectorId)) {
          latestByConnector.set(episode.connectorId, episode);
        }
      }
    } finally {
      store.close();
    }

    const tiers: Record<string, FreshnessTier> = {};
    for (const connectorId of CONNECTOR_IDS) {
      tiers[connectorId] = manifest.tierForConnector(connectorId);
    }
    const plan = planRefresh(tiers, latestByConnector);

    if (plan.due.length === 0) {
      process.stdout.write("All sources are within their freshness windows.\n");
      return;
    }

    process.stdout.write(
      `Refreshing ${plan.due.length} source(s); deferring ${plan.deferred.length}.\n`,
    );
    for (const decision of plan.due) {
      process.stdout.write(
        `  -> ${decision.entry.connectorId} [${decision.entry.tier}] (${decision.entry.reason})\n`,
      );
    }

    for (const decision of plan.due) {
      const connectorId = decision.entry.connectorId;
      if (!isConnectorId(connectorId)) {
        process.stderr.write(
          `Skipping unknown connector in refresh plan: ${connectorId}\n`,
        );
        continue;
      }
      process.stdout.write(`Running ingestion for ${connectorId}...\n`);
      try {
        await runOpenWikiIngestion(process.cwd(), { target: connectorId });
      } catch (error) {
        process.stderr.write(
          `Ingestion failed for ${connectorId}: ${getErrorMessage(error)}\n`,
        );
        process.exitCode = 1;
      }
    }
  } finally {
    await lease.release();
  }
}

/** Prints a deterministic context packet for a query over the local book. */
async function printBookContext(bookDir: string, query: string): Promise<void> {
  if (query.trim().length === 0) {
    process.stderr.write(
      "A search query is required, e.g. stratiki book context deploy pipeline.\n",
    );
    process.exitCode = 1;
    return;
  }

  const index = await ContextIndex.buildFromDirectory(bookDir);
  try {
    process.stdout.write(renderPacket(query, index.search(query)));
  } finally {
    index.close();
  }
}

async function loadManifestOrThrow(
  bookDir: string,
): Promise<WorkspaceManifest> {
  return WorkspaceManifest.load(path.join(bookDir, BOOK_MANIFEST_FILENAME));
}

/**
 * True only when a readable file exists at the path. Any other read failure
 * (permissions, a directory at the path) rethrows so it surfaces as a real
 * error instead of silently allowing an overwrite attempt.
 */
async function manifestExists(manifestPath: string): Promise<boolean> {
  try {
    await readFile(manifestPath, "utf8");
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}
