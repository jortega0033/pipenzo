import { randomUUID } from 'node:crypto';
import { open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  PIPENZO_MAX_CONNECTED_REPOS,
  pipenzoConnectedReposV1Schema,
  type PipenzoConnectedReposV1,
} from '@agent-dock/shared';
import { ensureStateDirectory } from './state-directory.js';

/**
 * A rename is only durable once the *directory* entry is on disk, not just the file's contents.
 *
 * Copied rather than imported, which is the existing convention here — `workspace-trust-store.ts`
 * and `audit-store.ts` each carry their own private copy, and neither exports one. A third copy is
 * the wrong trade in isolation and the right one against the alternative of one module reaching
 * into another's internals; the honest fix is a shared `durable-write.ts`, which is a refactor of
 * three call sites rather than a thing to smuggle into a repo picker.
 *
 * POSIX only: Windows cannot `open` a directory, and NTFS journals the metadata anyway, so a
 * failure here is expected rather than a problem.
 */
async function syncParentDirectory(directory: string): Promise<void> {
  try {
    const handle = await open(directory, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // See above.
  }
}

/**
 * The repositories a human told Pipenzo to manage (issue #115).
 *
 * ## Why this is not keyed by workspace id
 *
 * Every other durable store here is keyed by agentdock's `workspaceId` — a hash of a trusted local
 * directory. This one is not, and the reason is when it is written: the picker runs during
 * **first-run**, before any repository has been cloned and before there is a local directory to
 * hash. "The workspace" in the Pipenzo sense is this installation, not a checkout, so the list is
 * one list per daemon state directory. Keying it by something that does not exist yet would mean
 * inventing a placeholder identity and then having to migrate off it.
 *
 * ## Why the whole list is replaced on every write
 *
 * The writer is a picker with checkboxes, which is a statement about the complete selection.
 * Unticking a box has to mean something, so an append-only store would need a matching remove and
 * a screen that diffs the two — three ways to be wrong instead of one.
 *
 * A malformed or truncated file reads as **an empty list**, not as an error. This store answers a
 * question that gates the pre-app: "has anyone chosen repositories yet?". Throwing would take an
 * installation whose state file got corrupted and lock it out of the screen that would fix it,
 * whereas answering "none yet" puts the user back in the picker they already know how to use. The
 * corrupt file is replaced by the next write rather than left to fail forever.
 */

/** The on-disk envelope. Versioned so a future shape change is a new number, not a guess. */
interface ConnectedReposFileV1 {
  readonly version: 1;
  readonly repositories: readonly string[];
  readonly updatedAt?: string;
}

const EMPTY: PipenzoConnectedReposV1 = { repositories: [] };

export class ConnectedReposStore {
  #cached: PipenzoConnectedReposV1 | undefined;
  /** Serializes concurrent writes, so two picker submissions cannot interleave their renames. */
  #writeTail: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  /**
   * The current list. Cached after the first read, since only this class writes it.
   *
   * The re-check after the await is not redundant. `GET` and `PUT` are independent HTTP requests,
   * so a cold-cache read can be in flight while a write lands — and without this, `#load()`'s
   * pre-rename answer would overwrite the value the write just cached, leaving every later read
   * serving a list older than the file for the life of the process. The gate would then read `0`
   * for a configured install and route it back to the picker on every launch.
   */
  async read(): Promise<PipenzoConnectedReposV1> {
    if (this.#cached) return this.#cached;
    const loaded = await this.#load();
    // A write that landed during the load is newer than anything the load could have seen.
    if (this.#cached) return this.#cached;
    this.#cached = loaded;
    return this.#cached;
  }

  /**
   * Replaces the list, de-duplicated and in a stable order.
   *
   * Sorted rather than kept in the order the picker happened to send: this file is read back by a
   * reconciler that iterates it, and an order that depends on which checkbox was clicked first is
   * an order that makes two identical selections produce different files.
   */
  async replace(repositories: readonly string[]): Promise<PipenzoConnectedReposV1> {
    // De-duplicated *before* the cap is applied, so a request that repeats one repository fifty
    // times is one repository rather than a rejection.
    const unique = [...new Set(repositories)].sort((a, b) => a.localeCompare(b));
    if (unique.length > PIPENZO_MAX_CONNECTED_REPOS) {
      throw new ConnectedReposStoreError(
        'too_many_repositories',
        `at most ${PIPENZO_MAX_CONNECTED_REPOS} repositories can be connected`,
      );
    }
    const next: PipenzoConnectedReposV1 = {
      repositories: unique,
      updatedAt: new Date().toISOString(),
    };
    // Validated on the way *in*, so a bad value fails here rather than becoming a file that every
    // later read has to cope with.
    const parsed = pipenzoConnectedReposV1Schema.parse(next);
    const write = this.#writeTail.then(() => this.#persist(parsed));
    // `catch` on the tail only: the returned promise must still reject for this caller.
    this.#writeTail = write.catch(() => undefined);
    await write;
    this.#cached = parsed;
    return parsed;
  }

  async #load(): Promise<PipenzoConnectedReposV1> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch {
      // No file yet is the ordinary first-run answer, not a failure.
      return EMPTY;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<ConnectedReposFileV1>;
      if (parsed.version !== 1) return EMPTY;
      return pipenzoConnectedReposV1Schema.parse({
        repositories: parsed.repositories ?? [],
        ...(parsed.updatedAt ? { updatedAt: parsed.updatedAt } : {}),
      });
    } catch {
      // See the module comment: an unreadable list is "none chosen yet", never a locked door.
      return EMPTY;
    }
  }

  /** Temp file, fsync, rename, fsync the directory — the same durability the trust store uses. */
  async #persist(value: PipenzoConnectedReposV1): Promise<void> {
    const directory = dirname(this.filePath);
    await ensureStateDirectory(directory);
    const temporaryPath = join(directory, `.connected-repos-${randomUUID()}.tmp`);
    let renamed = false;
    try {
      const handle = await open(temporaryPath, 'wx', 0o600);
      try {
        const payload: ConnectedReposFileV1 = {
          version: 1,
          repositories: value.repositories,
          ...(value.updatedAt ? { updatedAt: value.updatedAt } : {}),
        };
        await handle.writeFile(`${JSON.stringify(payload)}\n`, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporaryPath, this.filePath);
      renamed = true;
      await syncParentDirectory(directory);
    } finally {
      if (!renamed) await unlink(temporaryPath).catch(() => undefined);
    }
  }
}

export type ConnectedReposStoreErrorCode = 'too_many_repositories';

export class ConnectedReposStoreError extends Error {
  readonly code: ConnectedReposStoreErrorCode;

  constructor(code: ConnectedReposStoreErrorCode, message: string) {
    super(message);
    this.name = 'ConnectedReposStoreError';
    this.code = code;
  }
}
