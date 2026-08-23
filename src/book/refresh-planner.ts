import type { EpisodeRecord } from "./episode-store.js";
import { tierMaxAgeHours } from "./freshness.js";
import type { FreshnessTier } from "./types.js";

/**
 * The refresh planner decides which connectors are due for a pull, driven by
 * each source's freshness tier (knowledge half-life discipline): a source is
 * due when its newest episode's ingest time has aged past the tier window.
 * Sources with no episodes yet are always due.
 */

export interface RefreshPlanEntry {
  readonly connectorId: string;
  readonly lastIngestIso: string | null;
  readonly reason: "never-pulled" | "tier-window-elapsed";
  readonly tier: FreshnessTier;
}

export type RefreshDecision =
  | { readonly entry: RefreshPlanEntry; readonly outcome: "due" }
  | {
      readonly entry: RefreshPlanEntry;
      readonly hoursRemaining: number;
      readonly outcome: "deferred";
    };

export function planRefresh(
  tiers: Readonly<Record<string, FreshnessTier>>,
  latestEpisodeByConnector: ReadonlyMap<string, EpisodeRecord>,
  now: Date = new Date(),
): { deferred: RefreshDecision[]; due: RefreshDecision[] } {
  const due: RefreshDecision[] = [];
  const deferred: RefreshDecision[] = [];

  for (const [connectorId, tier] of Object.entries(tiers)) {
    const latest = latestEpisodeByConnector.get(connectorId);
    if (latest === undefined) {
      due.push({
        entry: {
          connectorId,
          lastIngestIso: null,
          reason: "never-pulled",
          tier,
        },
        outcome: "due",
      });
      continue;
    }

    const ageMs = now.getTime() - Date.parse(latest.ingestTimeIso);
    if (!Number.isFinite(ageMs)) {
      // An unparseable ingest timestamp must not silently defer forever:
      // treat the source as due and let ingestion refresh the record.
      due.push({
        entry: {
          connectorId,
          lastIngestIso: latest.ingestTimeIso,
          reason: "tier-window-elapsed",
          tier,
        },
        outcome: "due",
      });
      continue;
    }

    const maxAgeMs = tierMaxAgeHours(tier) * 60 * 60 * 1000;
    if (ageMs >= maxAgeMs) {
      due.push({
        entry: {
          connectorId,
          lastIngestIso: latest.ingestTimeIso,
          reason: "tier-window-elapsed",
          tier,
        },
        outcome: "due",
      });
    } else {
      deferred.push({
        entry: {
          connectorId,
          lastIngestIso: latest.ingestTimeIso,
          reason: "tier-window-elapsed",
          tier,
        },
        hoursRemaining: Math.ceil((maxAgeMs - ageMs) / (60 * 60 * 1000)),
        outcome: "deferred",
      });
    }
  }

  return { deferred, due };
}
