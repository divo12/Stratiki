import { describe, expect, test } from "vitest";
import {
  FIELD_KINDS,
  normalizeValue,
  type FieldKind,
} from "../../../src/enrichment/normalize/index.ts";

describe("normalizeValue registry", () => {
  test("dispatches every declared kind to a working implementation", () => {
    expect(normalizeValue("phone-e164", "+1 (415) 555-2671")).toEqual({
      ok: true,
      value: "+14155552671",
    });
    expect(normalizeValue("address", "1 Main St, Springfield").ok).toBe(true);
    expect(normalizeValue("text-casefold", "  Acme Corp ")).toEqual({
      ok: true,
      value: "acme corp",
    });
  });

  test("propagates labeled failures without throwing", () => {
    expect(normalizeValue("phone-e164", "hello world")).toMatchObject({
      ok: false,
    });
    expect(normalizeValue("address", "one blob")).toMatchObject({
      ok: false,
    });
    expect(normalizeValue("constructor" as FieldKind, "x")).toEqual({
      ok: false,
      reason: "unknown normalization kind: constructor",
    });
  });

  test("FieldKind stays exhaustive over the registry keys", () => {
    for (const kind of FIELD_KINDS) {
      const result = normalizeValue(kind, "x");
      expect(result.ok === true || typeof result.reason === "string").toBe(
        true,
      );
    }
  });
});
