import { describe, expect, test } from "vitest";
import { parseDecisionSeed } from "../../src/strategy/parser.js";

describe("parseDecisionSeed", () => {
  test("creates a decision from a valid description", () => {
    const result = parseDecisionSeed({
      description: "Build a customer onboarding flow",
    });

    expect(result.id).toBeTruthy();
    expect(result.description).toBe("Build a customer onboarding flow");
    expect(result.status).toBe("active");
    expect(result.createdAt).toBeInstanceOf(Date);
  });

  test("trims whitespace from description", () => {
    const result = parseDecisionSeed({
      description: "  Improve API performance  ",
    });

    expect(result.description).toBe("Improve API performance");
  });

  test("throws on empty description", () => {
    expect(() => parseDecisionSeed({ description: "" })).toThrowError(
      "Decision description cannot be empty",
    );
  });

  test("throws on whitespace-only description", () => {
    expect(() => parseDecisionSeed({ description: "   " })).toThrowError(
      "Decision description cannot be empty",
    );
  });

  test("throws on description over 500 characters", () => {
    const longDescription = "a".repeat(501);
    expect(() =>
      parseDecisionSeed({ description: longDescription }),
    ).toThrowError("Decision description must be 500 characters or less");
  });

  test("accepts description at exactly 500 characters", () => {
    const description = "a".repeat(500);
    const result = parseDecisionSeed({ description });

    expect(result.description).toBe(description);
  });
});
