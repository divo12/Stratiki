import { describe, expect, test } from "vitest";
import { normalizeText } from "../../../src/enrichment/normalize/text.ts";

describe("normalizeText", () => {
  test("casefolds the match key and collapses whitespace", () => {
    expect(normalizeText("  Acme   Corp ")).toEqual({
      matchKey: "acme corp",
      display: "Acme Corp",
    });
  });

  test("folds smart punctuation via NFC before matching", () => {
    const result = normalizeText("Café\u00A0Größe");
    expect(result.matchKey).toBe("café größe");
    expect(result.display).toBe("Café Größe");
  });

  test("preserves capitalization signals in display only", () => {
    const result = normalizeText("iPhone 15 Pro");
    expect(result.matchKey).toBe("iphone 15 pro");
    expect(result.display).toBe("iPhone 15 Pro");
  });

  test("passes CJK through unchanged apart from whitespace rules", () => {
    const result = normalizeText("株式会社　タカラ");
    expect(result.display).toBe("株式会社 タカラ");
    expect(result.matchKey).toBe("株式会社 タカラ");
  });
});
