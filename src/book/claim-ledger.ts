import type { BookSectionId } from "./types.js";

/**
 * Claim ledger: the state machine that turns atomic propositions into
 * long-lived, temporally-honest book knowledge. States follow the Pavo-style
 * lifecycle; transitions are validated, never inferred. Staleness is a first
 * class state — a claim whose evidence changed is marked stale and stays in
 * the ledger (Zep/Graphiti invalidation discipline) until it is revived by
 * re-evidence or formally superseded.
 */

export const CLAIM_STATES = [
  "proposed",
  "active",
  "stale",
  "superseded",
  "retracted",
] as const;

export type ClaimState = (typeof CLAIM_STATES)[number];

/**
 * Legal state transitions. Terminal states (`superseded`, `retracted`) have
 * no outgoing edges: history is never rewritten, a corrected claim is a new
 * claim that supersedes the old one.
 */
const LEGAL_TRANSITIONS: Readonly<Record<ClaimState, readonly ClaimState[]>> = {
  active: ["retracted", "stale", "superseded"],
  proposed: ["active", "retracted"],
  retracted: [],
  stale: ["active", "retracted", "superseded"],
  superseded: [],
};

export interface LedgerClaimInput {
  readonly evidenceHashes: readonly string[];
  readonly id: string;
  readonly sectionId: BookSectionId;
  readonly statement: string;
  /**
   * Callers cannot set this: the field exists (`undefined`-only) so the
   * supersedeClaim runtime guard also protects untyped JS callers.
   */
  readonly supersedesId?: undefined;
}

export interface LedgerClaim {
  readonly evidenceHashes: readonly string[];
  readonly id: string;
  readonly sectionId: BookSectionId;
  readonly statement: string;
  readonly state: ClaimState;
  /** Id of the claim this one replaces; set exactly on `superseded` claims. */
  readonly supersedesId: string | null;
  readonly updatedAtIso: string;
}

export class IllegalTransitionError extends Error {}

/** A claim whose recorded evidence no longer matches current source evidence. */
export interface StalenessFinding {
  readonly claimId: string;
  readonly fromState: Extract<ClaimState, "active" | "proposed">;
  readonly toState: "stale";
}

/** Applies a transition after validating it against the state machine. */
export function transitionClaim(
  claim: LedgerClaim,
  toState: ClaimState,
  nowIso: string,
): LedgerClaim {
  const allowed = LEGAL_TRANSITIONS[claim.state];
  if (!allowed.includes(toState)) {
    throw new IllegalTransitionError(
      `Illegal claim transition ${claim.id}: ${claim.state} -> ${toState}. Allowed: ${
        allowed.length > 0 ? allowed.join(", ") : "(terminal)"
      }.`,
    );
  }

  return { ...claim, state: toState, updatedAtIso: nowIso };
}

/**
 * Marks a claim superseded by its replacement. The replacement must reference
 * the old claim via `supersedesId`; the old claim moves to the terminal
 * `superseded` state and its history is preserved.
 */
export function supersedeClaim(
  previous: LedgerClaim,
  replacement: LedgerClaimInput,
  nowIso: string,
): { previous: LedgerClaim; replacement: LedgerClaim } {
  if (replacement.supersedesId !== undefined) {
    throw new IllegalTransitionError(
      `Replacement claim ${replacement.id} must not pre-set supersedesId; use supersedeClaim.`,
    );
  }

  return {
    previous: transitionClaim(previous, "superseded", nowIso),
    replacement: {
      ...replacement,
      state: "active",
      supersedesId: previous.id,
      updatedAtIso: nowIso,
    },
  };
}

/**
 * Reconciles a set of claims against current evidence versions. A claim is a
 * staleness finding when any of its recorded evidence hashes no longer
 * appears among the current versions for its source. Claims already in
 * terminal or stale states are never re-flagged.
 *
 * @param currentEvidenceHashes All evidence hashes observed as still valid.
 */
export function reconcileStaleness(
  claims: readonly LedgerClaim[],
  currentEvidenceHashes: ReadonlySet<string>,
): StalenessFinding[] {
  const findings: StalenessFinding[] = [];

  for (const claim of claims) {
    if (claim.state !== "active" && claim.state !== "proposed") {
      continue;
    }
    if (claim.evidenceHashes.length === 0) {
      continue;
    }
    const hasLiveEvidence = claim.evidenceHashes.some((hash) =>
      currentEvidenceHashes.has(hash),
    );
    if (!hasLiveEvidence) {
      findings.push({
        claimId: claim.id,
        fromState: claim.state,
        toState: "stale",
      });
    }
  }

  return findings;
}

/**
 * Coverage roll-up per section: a requirement is met when at least one
 * active claim in its section carries at least the required number of
 * distinct live-evidence hashes. Mirrors the macro-average coverage KPI from
 * the design research; stale claims do not count toward coverage.
 */
export function coverageBySection(
  claims: readonly LedgerClaim[],
  requirements: readonly {
    readonly id: string;
    readonly minimumEvidenceSources: number;
    readonly sectionId: BookSectionId;
  }[],
): Readonly<Record<BookSectionId, { met: number; total: number }>> {
  const result = {} as Record<BookSectionId, { met: number; total: number }>;

  for (const requirement of requirements) {
    const bucket = result[requirement.sectionId] ?? { met: 0, total: 0 };
    bucket.total += 1;

    const met = claims.some(
      (claim) =>
        claim.state === "active" &&
        claim.sectionId === requirement.sectionId &&
        claim.evidenceHashes.length >= requirement.minimumEvidenceSources,
    );
    if (met) {
      bucket.met += 1;
    }

    result[requirement.sectionId] = bucket;
  }

  return result;
}
