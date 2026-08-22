import { describe, expect, test } from "vitest";
import {
  coverageBySection,
  IllegalTransitionError,
  reconcileStaleness,
  supersedeClaim,
  transitionClaim,
  type LedgerClaim,
} from "../../src/book/claim-ledger.js";
import type { BookSectionId } from "../../src/book/types.js";

const NOW = "2026-08-22T12:00:00.000Z";

function claim(overrides?: Partial<LedClaimOverrides>): LedgerClaim {
  return {
    evidenceHashes: ["hash-1"],
    id: "claim-1",
    sectionId: "u3-architecture",
    statement: "The API uses token auth.",
    state: "active",
    supersedesId: null,
    updatedAtIso: NOW,
    ...overrides,
  };
}

type LedClaimOverrides = Partial<{
  evidenceHashes: string[];
  id: string;
  sectionId: BookSectionId;
  statement: string;
  state: LedgerClaim["state"];
  supersedesId: string | null;
}>;

describe("claim state machine", () => {
  test("allows the happy lifecycle proposed -> active -> stale -> superseded", () => {
    const proposed = claim({ state: "proposed" });
    const active = transitionClaim(proposed, "active", NOW);
    const stale = transitionClaim(active, "stale", NOW);
    const superseded = transitionClaim(stale, "superseded", NOW);

    expect([active.state, stale.state, superseded.state]).toEqual([
      "active",
      "stale",
      "superseded",
    ]);
  });

  test("revives a stale claim when re-evidence arrives", () => {
    const stale = claim({ state: "stale" });
    expect(transitionClaim(stale, "active", NOW).state).toBe("active");
  });

  test.each([
    ["proposed", "superseded"],
    ["proposed", "stale"],
    ["superseded", "retracted"],
    ["retracted", "active"],
    ["active", "proposed"],
  ] as const)("rejects illegal %s -> %s", (from, to) => {
    expect(() => transitionClaim(claim({ state: from }), to, NOW)).toThrow(
      IllegalTransitionError,
    );
  });

  test("error names the claim and both states", () => {
    try {
      transitionClaim(claim({ id: "c9", state: "retracted" }), "active", NOW);
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toContain("c9");
      expect((error as Error).message).toContain("retracted -> active");
    }
  });
});

describe("supersession", () => {
  test("links replacement to previous and terminates the old claim", () => {
    const previous = claim({ id: "old" });
    const { previous: oldClaim, replacement } = supersedeClaim(
      previous,
      {
        evidenceHashes: ["hash-2"],
        id: "new",
        sectionId: "u3-architecture",
        statement: "The API uses OAuth device flow.",
      },
      NOW,
    );

    expect(oldClaim.state).toBe("superseded");
    expect(replacement.state).toBe("active");
    expect(replacement.supersedesId).toBe("old");
    expect(replacement.updatedAtIso).toBe(NOW);
  });

  test("rejects a replacement that pre-sets supersedesId", () => {
    const previous = claim({ id: "old" });
    expect(() =>
      supersedeClaim(
        previous,
        {
          evidenceHashes: [],
          id: "new",
          sectionId: "u3-architecture",
          statement: "x",
          // @ts-expect-error exercising runtime misuse of the input type
          supersedesId: "sneaky",
        },
        NOW,
      ),
    ).toThrow(IllegalTransitionError);
  });
});

describe("staleness reconciliation", () => {
  test("flags claims whose evidence no longer matches current versions", () => {
    const findings = reconcileStaleness(
      [
        claim({ id: "live", evidenceHashes: ["still-valid"] }),
        claim({ id: "dead", evidenceHashes: ["vanished-hash"] }),
        claim({
          id: "mixed",
          evidenceHashes: ["vanished-hash", "still-valid"],
        }),
      ],
      new Set(["still-valid"]),
    );

    expect(findings.map((finding) => finding.claimId)).toEqual(["dead"]);
    expect(findings[0]?.toState).toBe("stale");
  });

  test("never re-flags terminal or already-stale claims", () => {
    const findings = reconcileStaleness(
      [
        claim({ id: "already-stale", state: "stale" }),
        claim({ id: "gone", state: "superseded" }),
        claim({ id: "withdrawn", state: "retracted" }),
      ],
      new Set(),
    );

    expect(findings).toEqual([]);
  });

  test("claims with no recorded evidence are skipped, not flagged", () => {
    expect(
      reconcileStaleness([claim({ evidenceHashes: [] })], new Set()),
    ).toEqual([]);
  });
});

describe("coverageBySection", () => {
  const requirements = [
    {
      id: "u1.base",
      minimumEvidenceSources: 1,
      sectionId: "u1-purpose" as const,
    },
    { id: "u6.deep", minimumEvidenceSources: 2, sectionId: "u6-gaps" as const },
  ];

  test("counts only active claims with sufficient distinct evidence", () => {
    const coverage = coverageBySection(
      [
        claim({ id: "c1", sectionId: "u1-purpose", evidenceHashes: ["a"] }),
        claim({
          id: "c2",
          sectionId: "u6-gaps",
          evidenceHashes: ["a"],
        }),
        claim({ id: "c3", sectionId: "u6-gaps", evidenceHashes: ["a", "b"] }),
        claim({
          id: "c4-stale",
          sectionId: "u6-gaps",
          state: "stale",
          evidenceHashes: ["a", "b", "c"],
        }),
      ],
      requirements,
    );

    expect(coverage["u1-purpose"]).toEqual({ met: 1, total: 1 });
    // c3 meets the two-source bar; stale c4 does not count.
    expect(coverage["u6-gaps"]).toEqual({ met: 1, total: 1 });
  });

  test("unmet requirements report met=0 without fabricating sections", () => {
    const coverage = coverageBySection([], requirements);

    expect(coverage["u1-purpose"]).toEqual({ met: 0, total: 1 });
    expect(coverage["u6-gaps"]).toEqual({ met: 0, total: 1 });
    expect(Object.keys(coverage)).toHaveLength(2);
  });
});
