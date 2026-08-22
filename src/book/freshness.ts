import {
  FRESHNESS_TIERS,
  TIER_MAX_AGE_HOURS,
  type FreshnessTier,
} from "./types.js";

/** Resolves the maximum age in hours a tier's data may reach before refresh. */
export function tierMaxAgeHours(tier: FreshnessTier): number {
  return TIER_MAX_AGE_HOURS[tier];
}

/**
 * Computes the ISO timestamp at which data pulled at `pulledAtIso` becomes
 * stale for its tier. Returns `null` for an unparseable pull timestamp rather
 * than throwing: a bad timestamp must degrade to "never auto-stale" and be
 * surfaced by callers, not crash ingestion.
 */
export function computeStaleAfter(
  tier: FreshnessTier,
  pulledAtIso: string,
): string | null {
  const pulledMs = Date.parse(pulledAtIso);
  if (Number.isNaN(pulledMs)) {
    return null;
  }

  return new Date(
    pulledMs + tierMaxAgeHours(tier) * 60 * 60 * 1000,
  ).toISOString();
}

/**
 * Reports whether data with the given `staleAfterIso` threshold is stale as of
 * `now`. A missing or unparseable threshold is treated as stale so that
 * unknown freshness surfaces for review instead of silently living forever.
 */
export function isStale(
  staleAfterIso: string | null,
  now: Date = new Date(),
): boolean {
  if (staleAfterIso === null) {
    return true;
  }

  const thresholdMs = Date.parse(staleAfterIso);
  if (Number.isNaN(thresholdMs)) {
    return true;
  }

  return now.getTime() >= thresholdMs;
}

/** Narrows an unknown config value to a FreshnessTier, or `null` when invalid. */
export function parseFreshnessTier(value: unknown): FreshnessTier | null {
  return (FRESHNESS_TIERS as readonly unknown[]).includes(value)
    ? (value as FreshnessTier)
    : null;
}
