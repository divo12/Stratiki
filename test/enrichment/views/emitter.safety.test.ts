import { describe, expect, test } from "vitest";
import {
  emitCreateView,
  viewNameForDataset,
  ViewMappingError,
} from "../../../src/enrichment/views/emitter.ts";
import type { ViewMappingSet } from "../../../src/book/view-mappings.ts";

const PAYLOADS: readonly string[] = [
  "'; DROP TABLE episodes;--",
  "a'b",
  'x"y',
  "col;--comment",
  "UNION",
  "slashed/name",
  "back\\slash",
  "unicode-é",
  "${injection}",
];

// Paths live inside a quoted SQL literal with quotes escaped and a strict
// character allowlist, so keyword payloads like UNION are harmless there.
const PATH_PAYLOADS = PAYLOADS.filter((payload) => payload !== "UNION");

function setWith(
  overrides: Partial<ViewMappingSet["columns"][number]>,
): ViewMappingSet {
  return {
    columns: [
      { columnName: "safe", jsonPath: "safe", normalizer: "", ...overrides },
    ],
    datasetId: "stripe/stripe-events",
    version: 1,
  };
}

describe("identifier-injection safety matrix", () => {
  test("rejects every hostile column name before SQL is built", () => {
    for (const payload of PAYLOADS) {
      expect(() => emitCreateView(setWith({ columnName: payload })), payload).toThrow(
        ViewMappingError,
      );
    }
  });

  test("rejects every hostile json path", () => {
    for (const payload of PATH_PAYLOADS) {
      expect(() => emitCreateView(setWith({ jsonPath: payload })), payload).toThrow(
        ViewMappingError,
      );
    }
  });

  test("hostile dataset ids sanitize into safe identifiers", () => {
    for (const payload of ["x; DROP TABLE users", "X/Y!!"]) {
      const name = viewNameForDataset(payload);
      expect(name, payload).toMatch(/^[a-z0-9_]+$/u);
      expect(name.startsWith("v_"), payload).toBe(true);
    }
    // Unsanitizable ids collapse to nothing and are rejected.
    expect(() => viewNameForDataset("!!!")).toThrow(ViewMappingError);
  });

  test("rejects prototype-polluting column names explicitly", () => {
    for (const columnName of ["__proto__", "constructor", "prototype"]) {
      expect(() => emitCreateView(setWith({ columnName })), columnName).toThrow(
        ViewMappingError,
      );
    }
  });

  test("positive control: the known-good mapping still emits", () => {
    const sql = emitCreateView(setWith({}));

    expect(sql).toContain("CREATE VIEW IF NOT EXISTS v_stripe_stripe_events");
    expect(sql).toContain("AS safe");
  });
});
