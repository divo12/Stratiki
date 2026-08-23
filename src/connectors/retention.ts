import { readFileSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { CONNECTOR_IDS } from "./registry.js";
import { getConnectorRawDir } from "../config/openwiki-home.js";
import type { ConnectorId } from "./types.js";

/**
 * Lake-level raw retention policy, stored at ~/.openwiki/lake.json.
 *
 * With no policy file (or an empty one) nothing is ever deleted; retention
 * only activates when a TTL is configured explicitly.
 */
export interface LakeRetentionPolicy {
  /** TTL applied to connectors without their own override. Absent = forever. */
  defaultRetentionDays?: number;

  /** Per-connector TTL overrides in days. */
  connectors?: Partial<Record<ConnectorId, { retentionDays?: number }>>;
}

const PARTITION_PATTERN = /^dt=(\d{4}-\d{2}-\d{2})$/u;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Reads the lake retention policy from the home directory.
 *
 * @param home - Lake home directory containing lake.json.
 * @returns Parsed policy; empty object when absent or malformed.
 */
export function readLakeRetentionPolicy(home: string): LakeRetentionPolicy {
  let raw: string;
  try {
    raw = readFileSync(path.join(home, "lake.json"), "utf8");
  } catch {
    return {};
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return {};
    }

    return parsed;
  } catch {
    return {};
  }
}
/**
 * Resolves the effective TTL in days for one connector.
 *
 * @param policy - Lake retention policy.
 * @param connectorId - Connector whose raw zone is being evaluated.
 * @returns TTL in days, or `null` when the connector is kept forever.
 */
export function resolveRetentionDays(
  policy: LakeRetentionPolicy,
  connectorId: ConnectorId,
): number | null {
  const override =
    typeof policy.connectors === "object" && policy.connectors !== null
      ? policy.connectors[connectorId]?.retentionDays
      : undefined;
  const days =
    normalizeDays(override) ?? normalizeDays(policy.defaultRetentionDays);

  return days;
}

/**
 * Lists partition directory names strictly older than the resolved TTL.
 * Legacy flat run directories and anything not matching `dt=YYYY-MM-DD`
 * are never eligible.
 *
 * @param partitionNames - Directory names inside one connector's raw zone.
 * @param retentionDays - TTL in days; `null` keeps everything.
 * @param today - Reference date for age computation.
 * @returns Expired partition names ready for deletion.
 */
export function listExpiredPartitionNames(
  partitionNames: readonly string[],
  retentionDays: number | null,
  today: Date,
): string[] {
  if (retentionDays === null) return [];

  // Calendar-day arithmetic: a partition is kept while its day falls within
  // the last `retentionDays` calendar days, inclusive of today.
  const todayUtc = Date.UTC(
    today.getUTCFullYear(),
    today.getUTCMonth(),
    today.getUTCDate(),
  );
  const cutoffMs = todayUtc - (retentionDays - 1) * DAY_MS;

  return partitionNames.filter((name) => {
    const match = PARTITION_PATTERN.exec(name);
    if (match === null || match[1] === undefined) return false;
    const partitionMs = Date.parse(`${match[1]}T00:00:00Z`);

    return Number.isFinite(partitionMs) && partitionMs < cutoffMs;
  });
}

/**
 * Deletes expired date partitions under one connector's raw zone.
 *
 * @param connectorId - Connector whose raw zone is pruned.
 * @param policy - Lake retention policy.
 * @param today - Reference date.
 * @returns Names of partitions that were removed.
 */
export async function pruneConnectorRawPartitions(
  connectorId: ConnectorId,
  policy: LakeRetentionPolicy,
  today: Date,
): Promise<string[]> {
  const retentionDays = resolveRetentionDays(policy, connectorId);
  if (retentionDays === null) return [];

  const rawDir = getConnectorRawDir(connectorId);
  let entries;
  try {
    entries = await readdir(rawDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const expired = listExpiredPartitionNames(
    entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name),
    retentionDays,
    today,
  );

  for (const name of expired) {
    await rm(path.join(rawDir, name), { force: true, recursive: true });
  }

  return expired;
}

function normalizeDays(days: number | undefined): number | null {
  if (typeof days !== "number" || !Number.isFinite(days)) return null;
  const truncated = Math.trunc(days);

  return truncated >= 1 ? truncated : null;
}

/**
 * Prunes expired date partitions across every registered connector.
 *
 * @param policy - Lake retention policy.
 * @param today - Reference date.
 * @returns Removed partitions per connector; connectors without removals are
 * omitted.
 */
export async function pruneLakeRawPartitions(
  policy: LakeRetentionPolicy,
  today: Date,
): Promise<{ connectorId: ConnectorId; removed: string[] }[]> {
  const outcomes: { connectorId: ConnectorId; removed: string[] }[] = [];

  for (const connectorId of CONNECTOR_IDS) {
    try {
      const removed = await pruneConnectorRawPartitions(
        connectorId,
        policy,
        today,
      );
      if (removed.length > 0) {
        outcomes.push({ connectorId, removed });
      }
    } catch {
      // Retention is best-effort maintenance; a failing connector must not
      // break the ingestion run that triggered the pass.
    }
  }

  return outcomes;
}
