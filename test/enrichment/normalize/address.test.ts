import { describe, expect, test } from "vitest";
import { normalizeAddress } from "../../../src/enrichment/normalize/address.ts";

describe("normalizeAddress", () => {
  test("parses street and city", () => {
    expect(normalizeAddress("123 Main St, Springfield")).toEqual({
      ok: true,
      value: JSON.stringify({
        line1: "123 Main St",
        city: "Springfield",
        region: "",
        postal: "",
        country: "",
      }),
    });
  });

  test("splits region from a trailing postal code", () => {
    const result = normalizeAddress(
      "1 Market St, San Francisco, CA 94105, USA",
    );
    expect(JSON.parse(result.ok ? result.value : "{}")).toEqual({
      line1: "1 Market St",
      city: "San Francisco",
      region: "CA",
      postal: "94105",
      country: "USA",
    });
  });

  test("keeps an unsplit region intact when no postal token exists", () => {
    const result = normalizeAddress("742 Evergreen Terrace, Portland, Oregon");
    expect(JSON.parse(result.ok ? result.value : "{}")).toMatchObject({
      city: "Portland",
      region: "Oregon",
      postal: "",
    });
  });

  test("handles UK-style alphanumeric postcodes", () => {
    const result = normalizeAddress(
      "10 Downing St, London, Westminster SW1A 2AA, UK",
    );
    expect(JSON.parse(result.ok ? result.value : "{}")).toMatchObject({
      city: "London",
      region: "Westminster",
      postal: "SW1A 2AA",
      country: "UK",
    });
  });

  test("handles a postcode without a region", () => {
    const result = normalizeAddress("10 Downing St, London, SW1A 2AA");
    expect(JSON.parse(result.ok ? result.value : "{}")).toMatchObject({
      city: "London",
      region: "",
      postal: "SW1A 2AA",
    });
  });

  test("supports separate region and postal segments", () => {
    const result = normalizeAddress("1 Main St, Springfield, Illinois, 62704");
    expect(JSON.parse(result.ok ? result.value : "{}")).toMatchObject({
      city: "Springfield",
      region: "Illinois",
      postal: "62704",
    });
  });

  test("accepts Unicode country names", () => {
    const result = normalizeAddress(
      "1 Reforma, CDMX, Ciudad de México, México",
    );
    expect(JSON.parse(result.ok ? result.value : "{}")).toMatchObject({
      city: "CDMX",
      region: "Ciudad de México",
      country: "México",
    });
  });

  test("rejects empty and ambiguous segments", () => {
    expect(normalizeAddress("1 Main St,, Springfield").ok).toBe(false);
    expect(
      normalizeAddress("1 Main St, Springfield, Illinois, unknown, 62704").ok,
    ).toBe(false);
  });

  test("fails closed on garbage instead of guessing parts", () => {
    expect(normalizeAddress("just one blob").ok).toBe(false);
    expect(normalizeAddress("").ok).toBe(false);
  });
});
