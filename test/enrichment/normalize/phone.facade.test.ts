import { describe, expect, test } from "vitest";
import { normalizePhone } from "../../../src/enrichment/normalize/phone.ts";

describe("normalizePhone facade", () => {
  test("delegates to the core and preserves its result shape", () => {
    expect(normalizePhone("+1 (415) 555-2671")).toEqual({
      ok: true,
      value: "+14155552671",
    });
    expect(normalizePhone("not-a-phone")).toEqual({
      ok: false,
      reason: "phone contains letters or non-ascii digits",
    });
  });

  test("never throws on hostile input", () => {
    for (const input of ["", "+++", "x", "\u0000"]) {
      expect(() => normalizePhone(input)).not.toThrow();
      expect(normalizePhone(input).ok).toBe(false);
    }
  });
});
