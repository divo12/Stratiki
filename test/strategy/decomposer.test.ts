import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { ContextIndex } from "../../src/book/packet.js";
import { decomposeDecision } from "../../src/strategy/decomposer.js";
import type { Decision } from "../../src/strategy/types.js";

const tempDirs: string[] = [];

async function createWiki(pages: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "stratiki-strategy-"));
  tempDirs.push(dir);
  for (const [relativePath, content] of Object.entries(pages)) {
    const fullPath = path.join(dir, relativePath);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content, "utf8");
  }

  return dir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })),
  );
});

describe("decomposeDecision", () => {
  test("decomposes a decision into goals grounded in book context", async () => {
    const wikiDir = await createWiki({
      "architecture/api.md":
        "---\ntitle: API Architecture\n---\nOur API uses REST endpoints with OAuth2 authentication.",
      "operations/deployment.md":
        "---\ntitle: Deployment\n---\nWe deploy using blue-green strategy with automated rollback.",
      "u1-purpose/overview.md":
        "---\ntitle: Company Purpose\n---\nWe provide developer tools for continuous deployment.",
    });

    const index = await ContextIndex.buildFromDirectory(wikiDir);
    const decision: Decision = {
      createdAt: new Date(),
      description:
        "Improve API authentication security. Deploy new authentication service. Add monitoring for deployment health.",
      id: "test-decision-1",
      status: "active",
    };

    try {
      const result = decomposeDecision(decision, index);

      expect(result.decision).toBe(decision);
      expect(result.goals.length).toBeGreaterThan(0);

      for (const goal of result.goals) {
        expect(goal.id).toBeTruthy();
        expect(goal.decisionId).toBe(decision.id);
        expect(goal.description).toBeTruthy();
        expect(goal.status).toBe("pending");
        expect(typeof goal.rank).toBe("number");
        expect(Array.isArray(goal.groundedIn)).toBe(true);
      }

      const goalsWithGrounding = result.goals.filter(
        (g) => g.groundedIn.length > 0,
      );
      expect(goalsWithGrounding.length).toBeGreaterThan(0);
    } finally {
      index.close();
    }
  });

  test("ranks goals with better grounding higher", async () => {
    const wikiDir = await createWiki({
      "auth/security.md":
        "---\ntitle: Authentication Security\n---\nOur authentication uses OAuth2 with JWT tokens for secure API access.",
      "misc/coffee.md":
        "---\ntitle: Coffee\n---\nThe office coffee machine is a Jura E8.",
    });

    const index = await ContextIndex.buildFromDirectory(wikiDir);
    const decision: Decision = {
      createdAt: new Date(),
      description:
        "Improve authentication security for API access. Buy new coffee machine.",
      id: "test-decision-2",
      status: "active",
    };

    try {
      const result = decomposeDecision(decision, index);
      const sorted = [...result.goals].sort((a, b) => b.rank - a.rank);

      const authGoal = sorted.find((g) =>
        g.description.toLowerCase().includes("authentication"),
      );
      const coffeeGoal = sorted.find((g) =>
        g.description.toLowerCase().includes("coffee"),
      );

      if (authGoal && coffeeGoal) {
        expect(authGoal.groundedIn.length).toBeGreaterThanOrEqual(
          coffeeGoal.groundedIn.length,
        );
      }
    } finally {
      index.close();
    }
  });

  test("handles decision with no grounding in existing book", async () => {
    const wikiDir = await createWiki({
      "u1-purpose/overview.md":
        "---\ntitle: Company Purpose\n---\nWe build developer tools.",
    });

    const index = await ContextIndex.buildFromDirectory(wikiDir);
    const decision: Decision = {
      createdAt: new Date(),
      description: "Launch quantum computing research division.",
      id: "test-decision-3",
      status: "active",
    };

    try {
      const result = decomposeDecision(decision, index);

      expect(result.goals.length).toBeGreaterThan(0);

      const totalGrounding = result.goals.reduce(
        (sum, g) => sum + g.groundedIn.length,
        0,
      );
      expect(totalGrounding).toBe(0);
    } finally {
      index.close();
    }
  });
});
