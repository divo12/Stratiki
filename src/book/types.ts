/**
 * Stratiki System Book domain types.
 *
 * The company brain is organized by the seven Essential Truths (U1–U7): a
 * fixed section ontology that coverage is measured against. Every knowledge
 * source is assigned a freshness tier at configuration time so the refresh
 * scheduler can prioritize what to re-pull instead of treating the whole book
 * as equally volatile.
 */

export const BOOK_SECTIONS = [
  "u1-purpose",
  "u2-metrics",
  "u3-architecture",
  "u4-data-flows",
  "u5-attempts",
  "u6-gaps",
  "u7-operations",
] as const;

export type BookSectionId = (typeof BOOK_SECTIONS)[number];

export const SECTION_LABELS: Readonly<Record<BookSectionId, string>> = {
  "u1-purpose": "Purpose & outcome",
  "u2-metrics": "Metrics & guardrails",
  "u3-architecture": "Current architecture",
  "u4-data-flows": "Data flows",
  "u5-attempts": "What has been tried",
  "u6-gaps": "Performance & gaps",
  "u7-operations": "Operations & ownership",
};

/** How often a source's data goes stale, expressed as a bounded enum value. */
export const FRESHNESS_TIERS = ["hot", "daily", "weekly", "cold"] as const;

export type FreshnessTier = (typeof FRESHNESS_TIERS)[number];

/** Maximum hours a tier's data may age before the refresh scheduler prioritizes it. */
export const TIER_MAX_AGE_HOURS: Readonly<Record<FreshnessTier, number>> = {
  cold: 24 * 30,
  daily: 24,
  hot: 1,
  weekly: 24 * 7,
};

export interface CoverageRequirement {
  readonly description: string;
  readonly id: string;
  /** Minimum distinct evidence sources a slot needs before it counts as verified. */
  readonly minimumEvidenceSources: number;
  readonly sectionId: BookSectionId;
}

export interface SourceFreshnessAssignment {
  readonly connectorId: string;
  readonly tier: FreshnessTier;
}
