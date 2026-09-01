import { randomUUID } from "node:crypto";
import type { Decision, DecisionSeedRequest } from "./types.js";

/**
 * Parses a decision seed request and creates a Decision record.
 */
export function parseDecisionSeed(request: DecisionSeedRequest): Decision {
  const description = request.description.trim();

  if (description.length === 0) {
    throw new Error("Decision description cannot be empty");
  }

  if (description.length > 500) {
    throw new Error("Decision description must be 500 characters or less");
  }

  return {
    createdAt: new Date(),
    description,
    id: randomUUID(),
    status: "active",
  };
}
