import { describe, expect, test } from "vitest";
import { normalizePhoneCore } from "../../../src/enrichment/normalize/phone-core.ts";

describe("normalizePhoneCore", () => {
  test("normalizes +led numbers to E.164 across formatting styles", () => {
    expect(normalizePhoneCore("+1 (415) 555-2671")).toEqual({
      ok: true,
      value: "+14155552671",
    });
    expect(normalizePhoneCore("+44 20 7946 0958")).toEqual({
      ok: true,
      value: "+442079460958",
    });
    expect(normalizePhoneCore("+91.98765.43210")).toEqual({
      ok: true,
      value: "+919876543210",
    });
  });

  test("falls back to bare digits without a plus lead", () => {
    expect(normalizePhoneCore("020 7946 0958")).toEqual({
      ok: true,
      value: "02079460958",
    });
    expect(normalizePhoneCore("(415) 555-2671")).toEqual({
      ok: true,
      value: "4155552671",
    });
  });

  test("drops extensions after x, #, comma, or semicolon", () => {
    expect(normalizePhoneCore("+1 415 555 2671 x123")).toEqual({
      ok: true,
      value: "+14155552671",
    });
    expect(normalizePhoneCore("415-555-2671#99")).toEqual({
      ok: true,
      value: "4155552671",
    });
  });

  test("rejects letters and non-ascii digits instead of guessing", () => {
    expect(normalizePhoneCore("call-me-maybe")).toMatchObject({
      ok: false,
    });
    expect(normalizePhoneCore("＋１２３４５６７")).toMatchObject({
      ok: false,
    });
  });

  test("rejects digit counts outside the E.164 range", () => {
    expect(normalizePhoneCore("+1 555 12")).toMatchObject({ ok: false });
    expect(normalizePhoneCore("12345678901234567890")).toMatchObject({
      ok: false,
    });
  });
});
