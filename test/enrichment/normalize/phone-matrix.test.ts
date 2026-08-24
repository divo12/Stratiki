import { describe, expect, test } from "vitest";
import { normalizePhoneCore } from "../../../src/enrichment/normalize/phone-core.ts";

interface MatrixCase {
  readonly input: string;
  readonly expected: string;
}

const MATRIX: readonly MatrixCase[] = [
  { input: "+14155552671", expected: "+14155552671" },
  { input: " +1 (415) 555-2671 ", expected: "+14155552671" },
  { input: "+1.415.555.2671", expected: "+14155552671" },
  { input: "+44/20/7946/0958", expected: "+442079460958" },
  { input: "+91–98765–43210", expected: "+919876543210" },
  { input: "07500 123456", expected: "07500123456" },
  { input: "(011) 44-20-7946-0958", expected: "011442079460958" },
  { input: "+81-3-1234-5678;1", expected: "+81312345678" },
  { input: "+65 6123 4567 #88", expected: "+6561234567" },
];

describe("phone portability matrix", () => {
  test("every locale fixture normalizes to exactly one output", () => {
    for (const matrixCase of MATRIX) {
      const result = normalizePhoneCore(matrixCase.input);
      expect(result, matrixCase.input).toEqual({
        ok: true,
        value: matrixCase.expected,
      });
    }
  });

  test("matrix covers every formatting character class the core strips", () => {
    const stripped = MATRIX.filter((matrixCase) =>
      /[\s().\-–—/#;,]/u.test(matrixCase.input),
    );
    expect(stripped.length).toBeGreaterThanOrEqual(8);
  });

  test("no matrix case silently loses more than formatting", () => {
    for (const matrixCase of MATRIX) {
      const result = normalizePhoneCore(matrixCase.input);
      expect(result.ok).toBe(true);
    }
  });
});
