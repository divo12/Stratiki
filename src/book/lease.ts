import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * A single-writer lease for the refresh loop. The daemon must never run
 * concurrently with itself: two refreshes racing would double-ingest and
 * interleave wiki edits. The lease is a small JSON file with an owner token
 * and a heartbeat; a stale lease (no heartbeat within the TTL) can be broken
 * by a later run so a crashed daemon cannot block the book forever.
 */

export const LEASE_TTL_MS = 60 * 60 * 1000;

export interface LeaseContents {
  readonly acquiredAtIso: string;
  readonly owner: string;
}

export type LeaseAcquireResult =
  | { readonly outcome: "acquired" }
  | {
      readonly holder: LeaseContents;
      readonly outcome: "held-by-other";
    };

export class BookLease {
  private constructor(
    private readonly filePath: string,
    private readonly owner: string,
  ) {}

  static at(leasePath: string, owner = `pid-${process.pid}`): BookLease {
    return new BookLease(leasePath, owner);
  }

  /**
   * Attempts to acquire the lease. Succeeds when no lease file exists or the
   * existing lease is stale beyond the TTL; fails with the current holder
   * otherwise.
   */
  async acquire(now: Date = new Date()): Promise<LeaseAcquireResult> {
    let existing: LeaseContents | null = null;
    try {
      const raw = JSON.parse(await readFile(this.filePath, "utf8")) as unknown;
      if (isLeaseContents(raw)) {
        existing = raw;
      }
    } catch {
      // Missing or unreadable lease file: nothing holds the lock.
    }

    if (
      existing !== null &&
      now.getTime() - Date.parse(existing.acquiredAtIso) < LEASE_TTL_MS
    ) {
      return { holder: existing, outcome: "held-by-other" };
    }

    await mkdirAndWrite(this.filePath, {
      acquiredAtIso: now.toISOString(),
      owner: this.owner,
    });

    return { outcome: "acquired" };
  }

  /** Releases the lease when still held by this instance. */
  async release(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.filePath, "utf8")) as unknown;
      if (isLeaseContents(raw) && raw.owner === this.owner) {
        await unlink(this.filePath);
      }
    } catch {
      // Already gone or unreadable: releasing is best-effort.
    }
  }
}

function isLeaseContents(value: unknown): value is LeaseContents {
  return (
    typeof value === "object" &&
    value !== null &&
    "acquiredAtIso" in value &&
    "owner" in value &&
    typeof (value as LeaseContents).acquiredAtIso === "string" &&
    typeof (value as LeaseContents).owner === "string"
  );
}

async function mkdirAndWrite(
  filePath: string,
  contents: LeaseContents,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(contents, null, 2)}\n`, "utf8");
}
