import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import * as normalize from "../../src/enrichment/normalize/index.ts";
import {
  emitCreateView,
  viewNameForDataset,
} from "../../src/enrichment/views/emitter.ts";
import {
  syncAllViews,
  syncDatasetView,
} from "../../src/enrichment/views/lifecycle.ts";
import { ViewMappingStore } from "../../src/book/view-mappings.ts";

const README_PATH = path.join(
  import.meta.dirname,
  "../../src/enrichment/README.md",
);

describe("enrichment docs", () => {
  test("every documented export exists at runtime (no doc drift)", () => {
    const readme = readFileSync(README_PATH, "utf8");

    const documentedExports = [
      "normalizeValue",
      "emitCreateView" satisfies keyof typeof import("../../src/enrichment/views/emitter.js"),
      "syncAllViews" satisfies keyof typeof import("../../src/enrichment/views/lifecycle.js"),
      "syncDatasetView" satisfies keyof typeof import("../../src/enrichment/views/lifecycle.js"),
      "ViewMappingStore" satisfies keyof typeof import("../../src/book/view-mappings.js"),
    ];
    for (const exportName of documentedExports) {
      expect(readme, exportName).toContain(exportName);
    }

    expect(typeof normalize.normalizeValue).toBe("function");
    expect(typeof emitCreateView).toBe("function");
    expect(typeof syncAllViews).toBe("function");
    expect(typeof syncDatasetView).toBe("function");
    expect(typeof ViewMappingStore.open).toBe("function");
  });

  test("documents every declared normalizer kind and the naming contract", () => {
    const readme = readFileSync(README_PATH, "utf8");

    for (const kind of normalize.FIELD_KINDS) {
      expect(readme).toContain(`\`${kind}\``);
    }
    expect(normalize.normalizeValue("phone-e164", "+1 (415) 555-2671")).toEqual(
      {
        ok: true,
        value: "+14155552671",
      },
    );
    expect(viewNameForDataset("stripe/stripe-events")).toBe(
      "v_stripe_stripe_events",
    );
    expect(readme).toContain("7–15 significant digits");
    expect(readme).toContain("`v_stripe_stripe_events`");
    expect(readme).toContain("no fuzzy matching exists in Phase 1");
  });
});
