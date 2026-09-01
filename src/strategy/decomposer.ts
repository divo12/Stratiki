import { randomUUID } from "node:crypto";
import type { ContextIndex, ContextPacketEntry } from "../book/packet.js";
import type { Decision, DecompositionResult, Goal } from "./types.js";

/**
 * Decomposes a decision into goals, grounded in the company brain context.
 *
 * This is a minimal implementation that:
 * 1. Searches the book for relevant context
 * 2. Decomposes the decision into simple goals
 * 3. Ranks goals based on how well they're grounded in existing knowledge
 */
export function decomposeDecision(
  decision: Decision,
  bookIndex: ContextIndex,
): DecompositionResult {
  const contextEntries = bookIndex.search(decision.description, 10);
  const goals = extractGoalsFromDecision(
    decision,
    contextEntries,
  );

  return {
    decision,
    goals,
  };
}

/**
 * Extracts goals from a decision description and ranks them by grounding.
 */
function extractGoalsFromDecision(
  decision: Decision,
  contextEntries: readonly ContextPacketEntry[],
): Goal[] {
  const now = new Date();
  const groundingPaths = new Set(contextEntries.map((entry) => entry.path));

  const rawGoals = parseGoalsFromDescription(decision.description);

  return rawGoals.map((goalDesc, index) => {
    const grounding = findGroundingForGoal(goalDesc, contextEntries);
    const rank = calculateRank(grounding, groundingPaths, index);

    return {
      createdAt: now,
      decisionId: decision.id,
      description: goalDesc,
      groundedIn: grounding,
      id: randomUUID(),
      rank,
      status: "pending",
      updatedAt: now,
    };
  });
}

/**
 * Naive goal extraction: split by sentence boundaries or bullet points.
 * In a real implementation, this would use an LLM.
 */
function parseGoalsFromDescription(description: string): string[] {
  const bulletPattern = /^[-*•]\s+(.+)$/gmu;
  const bullets: string[] = [];
  let match;

  while ((match = bulletPattern.exec(description)) !== null) {
    bullets.push(match[1].trim());
  }

  if (bullets.length > 0) {
    return bullets;
  }

  const sentences = description
    .split(/[.!?]+/u)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  return sentences.slice(0, 3);
}

/**
 * Finds book context paths that are relevant to a goal.
 */
function findGroundingForGoal(
  goalDesc: string,
  contextEntries: readonly ContextPacketEntry[],
): string[] {
  const goalWords = new Set(
    goalDesc
      .toLowerCase()
      .split(/\W+/u)
      .filter((w) => w.length > 3),
  );

  return contextEntries
    .filter((entry) => {
      const entryWords = new Set(
        entry.excerpt
          .toLowerCase()
          .split(/\W+/u)
          .filter((w) => w.length > 3),
      );

      const commonWords = [...goalWords].filter((w) => entryWords.has(w));
      return commonWords.length >= 1;
    })
    .map((entry) => entry.path);
}

/**
 * Calculates a goal's rank based on how well it's grounded.
 * Higher rank = better grounded = should be prioritized.
 */
function calculateRank(
  grounding: string[],
  _allPaths: Set<string>,
  baseIndex: number,
): number {
  const groundingScore = Math.min(grounding.length, 5) * 10;
  const positionPenalty = baseIndex;

  return 100 + groundingScore - positionPenalty;
}
