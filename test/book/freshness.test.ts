import { describe, expect, test } from "vitest";
import {
  computeStaleAfter,
  isStale,
  parseFreshnessTier,
  tierMaxAgeHours,
} from "../../src/book/freshness.js";

describe("freshness tiers", () => {
  test("maps each tier to its bounded max age in hours", () => {
    expect(tierMaxAgeHours("hot")).toBe(1);
    expect(tierMaxAgeHours("daily")).toBe(24);
    expect(tierMaxAgeHours("weekly")).toBe(168);
    expect(tierMaxAgeHours("cold")).toBe(720);
  });

  test("parses valid tier values and rejects everything else", () => {
    expect(parseFreshnessTier("daily")).toBe("daily");
    expect(parseFreshnessTier("HOT")).toBeNull();
    expect(parseFreshnessTier("hourly")).toBeNull();
    expect(parseFreshnessTier(null)).toBeNull();
    expect(parseFreshnessTier(undefined)).toBeNull();
  });
});

describe("computeStaleAfter", () => {
  test("adds the tier's window to the pull time", () => {
    const pulledAt = "2026-08-22T00:00:00.000Z";
    expect(computeStaleAfter("hot", pulledAt)).toBe("2026-08-22T01:00:00.000Z");
    expect(computeStaleAfter("daily", pulledAt)).toBe(
      "2026-08-23T00:00:00.000Z",
    );
    expect(computeStaleAfter("weekly", pulledAt)).toBe(
      "2026-08-29T00:00:00.000Z",
    );
  });

  test("returns null for an unparseable pull timestamp instead of throwing", () => {
    expect(computeStaleAfter("daily", "not-a-date")).toBeNull();
  });
});

describe("isStale", () => {
  const now = new Date("2026-08-22T12:00:00.000Z");

  test("is stale at or after the threshold and fresh while the window remains", () => {
    // Threshold already passed relative to `now`: stale.
    expect(isStale("2026-08-22T11:59:59.999Z", now)).toBe(true);
    // Threshold exactly at `now`: stale.
    expect(isStale("2026-08-22T12:00:00.000Z", now)).toBe(true);
    // Threshold still ahead of `now`: fresh.
    expect(isStale("2026-08-22T12:00:01.000Z", now)).toBe(false);
  });

  test("treats missing or malformed thresholds as stale", () => {
    expect(isStale(null, now)).toBe(true);
    expect(isStale("garbage", now)).toBe(true);
  });
});

describe("ISO timestamp strictness", () => {
  test("locale-format garbage is rejected, not treated as a future threshold", () => {
    expect(computeStaleAfter("daily", "12/31/9999")).toBeNull();
    // Locale dates parse to the past, which would silently read as stale;
    // rejecting them keeps unknown freshness visible.
    expect(isStale("12/31/9999", new Date("2026-08-22T12:00:00.000Z"))).toBe(
      true,
    );
  });

  test("offset-bearing ISO timestamps remain accepted", () => {
    // 15:00+02:00 == 13:00Z — still ahead of `now`, so fresh.
    expect(
      isStale(
        "2026-08-22T15:00:00+02:00",
        new Date("2026-08-22T12:00:00.000Z"),
      ),
    ).toBe(false);
    // 09:00-02:00 == 11:00Z — already behind `now`, so stale.
    expect(
      isStale(
        "2026-08-22T09:00:00-02:00",
        new Date("2026-08-22T12:00:00.000Z"),
      ),
    ).toBe(true);
  });
});
