import { readFile, writeFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  BOOK_SECTIONS,
  FRESHNESS_TIERS,
  type BookSectionId,
  type CoverageRequirement,
  type FreshnessTier,
  type SourceFreshnessAssignment,
} from "./types.js";

export const BOOK_MANIFEST_FILENAME = "book.config.json";

/**
 * The manifest schema. `version` is pinned so later evolutions can migrate
 * rather than guess; unknown fields are stripped, not carried.
 */
const requirementSchema = z.object({
  description: z.string().min(1),
  id: z.string().min(1),
  minimumEvidenceSources: z.number().int().min(1).max(10).default(1),
  sectionId: z.enum(BOOK_SECTIONS),
});

const sourceTierSchema = z.object({
  connectorId: z.string().min(1),
  tier: z.enum(FRESHNESS_TIERS),
});

const manifestSchema = z.object({
  description: z.string().min(1).optional(),
  name: z.string().min(1).max(120),
  requirements: z.array(requirementSchema).default([]),
  sourceTiers: z.array(sourceTierSchema).default([]),
  version: z.literal(1),
});

export type RawWorkspaceManifest = z.infer<typeof manifestSchema>;

/** One base coverage slot per section; the workspace extends from here. */
function baseRequirements(): CoverageRequirement[] {
  return BOOK_SECTIONS.map((sectionId) => ({
    description: `Core ${sectionId} truth is documented and evidence-backed.`,
    id: `${sectionId}.base`,
    minimumEvidenceSources: 1,
    sectionId,
  }));
}

/**
 * The typed view over `openwiki/book.config.json`. Constructed through
 * {@link WorkspaceManifest.parse} or {@link WorkspaceManifest.createDefault};
 * instances are immutable.
 */
export class WorkspaceManifest {
  private constructor(
    private readonly raw: RawWorkspaceManifest,
    private readonly requirements: readonly CoverageRequirement[],
  ) {}

  static createDefault(name: string, description?: string): WorkspaceManifest {
    return new WorkspaceManifest(
      {
        description,
        name,
        requirements: baseRequirements().map((requirement) => ({
          ...requirement,
        })),
        sourceTiers: [],
        version: 1,
      },
      baseRequirements(),
    );
  }

  /** Parses and validates an unknown JSON body into a typed manifest. */
  static parse(value: unknown): WorkspaceManifest {
    const result = manifestSchema.safeParse(value);
    if (!result.success) {
      throw new BookManifestError(formatIssues(result.error.issues));
    }

    // Requirement ids must be unique or later coverage aggregation would
    // double-count slots that are actually the same knowledge gap.
    const idCounts = new Map<string, number>();
    for (const requirement of result.data.requirements) {
      idCounts.set(requirement.id, (idCounts.get(requirement.id) ?? 0) + 1);
    }
    const duplicates = [...idCounts.entries()]
      .filter(([, count]) => count > 1)
      .map(([id]) => id);
    if (duplicates.length > 0) {
      throw new BookManifestError(
        `Invalid book manifest: duplicate requirement ids: ${duplicates.join(", ")}`,
      );
    }

    return new WorkspaceManifest(result.data, result.data.requirements);
  }

  static async load(manifestPath: string): Promise<WorkspaceManifest> {
    return WorkspaceManifest.parse(
      JSON.parse(await readFile(manifestPath, "utf8")),
    );
  }

  get description(): string | undefined {
    return this.raw.description;
  }

  get name(): string {
    return this.raw.name;
  }

  get sourceTiers(): readonly SourceFreshnessAssignment[] {
    return this.raw.sourceTiers;
  }

  get version(): number {
    return this.raw.version;
  }

  /** All coverage slots, grouped by section in canonical U1–U7 order. */
  requirementsBySection(): Readonly<
    Record<BookSectionId, readonly CoverageRequirement[]>
  > {
    const grouped = Object.fromEntries(
      BOOK_SECTIONS.map((sectionId) => [
        sectionId,
        [] as CoverageRequirement[],
      ]),
    ) as Record<BookSectionId, CoverageRequirement[]>;

    for (const requirement of this.requirements) {
      grouped[requirement.sectionId].push(requirement);
    }

    return grouped;
  }

  /** Resolves the freshness tier for a connector, defaulting to weekly. */
  tierForConnector(connectorId: string): FreshnessTier {
    return (
      this.raw.sourceTiers.find(
        (assignment) => assignment.connectorId === connectorId,
      )?.tier ?? "weekly"
    );
  }

  toJSON(): RawWorkspaceManifest {
    return structuredClone(this.raw);
  }

  async save(manifestPath: string): Promise<void> {
    await mkdir(path.dirname(manifestPath), { recursive: true });
    await writeFile(
      manifestPath,
      `${JSON.stringify(this.toJSON(), null, 2)}\n`,
      "utf8",
    );
  }
}

export class BookManifestError extends Error {}

function formatIssues(issues: z.ZodError["issues"]): string {
  const formatted = issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");

  return `Invalid book manifest: ${formatted}`;
}
