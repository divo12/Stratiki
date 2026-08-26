import { describe, expect, test } from "vitest";
import {
  emitCreateView,
  viewNameForDataset,
  ViewMappingError,
} from "../../../src/enrichment/views/emitter.ts";
import type { ViewMappingSet } from "../../../src/book/view-mappings.ts";

function buildSet(overrides?: Partial<ViewMappingSet>): ViewMappingSet {
  return {
    columns: [
      { columnName: "event_id", jsonPath: "id", normalizer: "" },
      {
        columnName: "customer_email",
        jsonPath: "customer.email",
        normalizer: "text-casefold",
      },
    ],
    datasetId: "stripe/stripe-events",
    version: 1,
    ...overrides,
  };
}

describe("emitCreateView", () => {
  test("emits deterministic json_extract projections with UDF wrapping", () => {
    const sql = emitCreateView(buildSet());

    expect(sql).toBe(
      "CREATE VIEW IF NOT EXISTS v_stripe_stripe_events AS " +
        "SELECT json_extract(content, '$.id') AS \"event_id\", " +
        "enrich_normalize('text-casefold', json_extract(content, '$.customer.email')) AS \"customer_email\" " +
        "FROM episodes WHERE connector_id = 'stripe'",
    );
  });

  test("re-emission is byte-identical", () => {
    expect(emitCreateView(buildSet())).toBe(emitCreateView(buildSet()));
  });

  test("sanitizes dataset ids into safe v_ names", () => {
    expect(viewNameForDataset("meta-ads/meta-insights")).toBe(
      "v_meta_ads_meta_insights",
    );
    expect(viewNameForDataset("google/google")).toMatch(/^v_google_google$/u);
  });

  test("rejects invalid identifiers, paths, kinds, and empty sets", () => {
    const badColumn = buildSet({
      columns: [{ columnName: "DROP TABLE", jsonPath: "id", normalizer: "" }],
    });
    expect(() => emitCreateView(badColumn)).toThrow(ViewMappingError);

    const badPath = buildSet({
      columns: [
        {
          columnName: "ok",
          jsonPath: "'; DROP TABLE episodes;--",
          normalizer: "",
        },
      ],
    });
    expect(() => emitCreateView(badPath)).toThrow(ViewMappingError);

    for (const jsonPath of [".", "a..b", "arr[abc]"]) {
      expect(() =>
        emitCreateView(
          buildSet({
            columns: [{ columnName: "ok", jsonPath, normalizer: "" }],
          }),
        ),
      ).toThrow(ViewMappingError);
    }

    const badKind = buildSet({
      columns: [
        { columnName: "ok", jsonPath: "id", normalizer: "explode" as never },
      ],
    });
    expect(() => emitCreateView(badKind)).toThrow(ViewMappingError);

    expect(() => emitCreateView(buildSet({ columns: [] }))).toThrow(
      ViewMappingError,
    );
  });
});
