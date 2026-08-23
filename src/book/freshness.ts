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
  const pulledMs = parseIsoTimestamp(pulledAtIso);
  if (pulledMs === null) {
    return null;
  }

  return new Date(
    pulledMs + tierMaxAgeHours(tier) * 60 * 60 * 1000,
  ).toISOString();
}

/**
 * Accepts only offset-bearing ISO-8601 timestamps. `Date.parse` alone also
 * accepts locale formats such as `12/31/9999`, which would let garbage
 * masquerade as a valid future freshness threshold.
 *
 * @returns Epoch milliseconds, or `null` for any non-ISO input.
 */
function parseIsoTimestamp(value: string): number | null {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/u.test(
      value,
    )
  ) {
    return null;
  }

  const parsedMs = Date.parse(value);

  return Number.isNaN(parsedMs) ? null : parsedMs;
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

  const thresholdMs = parseIsoTimestamp(staleAfterIso);
  if (thresholdMs === null) {
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
