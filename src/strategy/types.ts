/**
 * Stratiki Strategy Layer domain types.
 *
 * The strategy layer sits on top of the company brain, decomposing decisions
 * into goals that are grounded in existing organizational knowledge. Goals are
 * ranked by resource availability and decayed over time as they complete or
 * become stale.
 */

export interface Decision {
  readonly id: string;
  readonly description: string;
  readonly createdAt: Date;
  readonly status: DecisionStatus;
}

export type DecisionStatus = "active" | "completed" | "abandoned";

export interface Goal {
  readonly id: string;
  readonly decisionId: string;
  readonly description: string;
  readonly rank: number;
  readonly groundedIn: readonly string[];
  readonly status: GoalStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export type GoalStatus = "pending" | "active" | "done" | "failed" | "stale";

export interface DecisionSeedRequest {
  readonly description: string;
}

export interface DecompositionResult {
  readonly decision: Decision;
  readonly goals: readonly Goal[];
}
