import type { Decision, Goal } from "./types.js";

/**
 * Persistence layer for the strategy store.
 *
 * For the minimal viable implementation, we store decisions and goals
 * as simple JSON files in the book directory under `.strategy/`.
 */

export interface StrategyStore {
  saveDecision(decision: Decision): Promise<void>;
  saveGoals(goals: readonly Goal[]): Promise<void>;
  listDecisions(): Promise<Decision[]>;
  getGoalsForDecision(decisionId: string): Promise<Goal[]>;
}

export class FileStrategyStore implements StrategyStore {
  constructor(private readonly strategyDir: string) {}

  async saveDecision(decision: Decision): Promise<void> {
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(this.strategyDir, { recursive: true });

    const decisions = await this.listDecisions();
    decisions.push(decision);

    await writeFile(
      `${this.strategyDir}/decisions.json`,
      JSON.stringify(decisions, null, 2),
    );
  }

  async saveGoals(goals: readonly Goal[]): Promise<void> {
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(this.strategyDir, { recursive: true });

    for (const goal of goals) {
      const goalsForDecision = await this.getGoalsForDecision(
        goal.decisionId,
      );
      const existingIndex = goalsForDecision.findIndex((g) => g.id === goal.id);

      if (existingIndex >= 0) {
        goalsForDecision[existingIndex] = goal;
      } else {
        goalsForDecision.push(goal);
      }

      await writeFile(
        `${this.strategyDir}/goals-${goal.decisionId}.json`,
        JSON.stringify(goalsForDecision, null, 2),
      );
    }
  }

  async listDecisions(): Promise<Decision[]> {
    const { readFile } = await import("node:fs/promises");
    try {
      const content = await readFile(
        `${this.strategyDir}/decisions.json`,
        "utf8",
      );
      return JSON.parse(content);
    } catch {
      return [];
    }
  }

  async getGoalsForDecision(decisionId: string): Promise<Goal[]> {
    const { readFile } = await import("node:fs/promises");
    try {
      const content = await readFile(
        `${this.strategyDir}/goals-${decisionId}.json`,
        "utf8",
      );
      return JSON.parse(content);
    } catch {
      return [];
    }
  }
}
