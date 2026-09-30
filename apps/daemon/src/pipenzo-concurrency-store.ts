import { randomUUID } from 'node:crypto';
import { open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  PIPENZO_EXECUTION_LIMIT_DEFAULT,
  PIPENZO_RUN_BUDGET_DEFAULT,
  pipenzoConcurrencySettingsV1Schema,
  type PipenzoConcurrencySettingsUpdateV1,
  type PipenzoConcurrencySettingsV1,
} from '@agent-dock/shared';
import { ensureStateDirectory } from './state-directory.js';

/**
 * A rename is only durable once the *directory* entry is on disk, not just the file's contents.
 *
 * Copied rather than imported, matching this codebase's existing convention -- see
 * `connected-repos-store.ts`'s own comment on why a fourth copy is still the right trade over
 * reaching into another module's internals.
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
    // POSIX only: Windows cannot `open` a directory, and NTFS journals the metadata anyway.
  }
}

/**
 * The workspace's bounded-concurrency settings (Pipenzo issue #126): the execution-limit stepper's
 * value and the workspace default run budget, both set from Settings and both per-machine -- same
 * "one file beside the other durable stores" shape as `ConnectedReposStore`/`LessonStore`, for the
 * same reason: there is exactly one of these per daemon state directory, not one per workspace or
 * per repository.
 *
 * A missing or corrupt file reads as the product defaults (`executionLimit: 2`, `runBudget:
 * 'unlimited'`), never as an error -- an installation that has never opened Settings' Concurrency
 * panel has not "failed to configure" anything; it is running the same defaults README and the
 * design canvas both state. `PipenzoExecutionLimiter` (constructed from this store's `read()` at
 * daemon startup) enforces exactly this default until a person changes it.
 */

/** The on-disk envelope. Versioned so a future shape change is a new number, not a guess. */
interface ConcurrencySettingsFileV1 {
  readonly version: 1;
  readonly executionLimit: number;
  readonly runBudget: string;
}

const DEFAULT_SETTINGS: PipenzoConcurrencySettingsV1 = {
  schemaVersion: 1,
  executionLimit: PIPENZO_EXECUTION_LIMIT_DEFAULT,
  runBudget: PIPENZO_RUN_BUDGET_DEFAULT,
};

export class PipenzoConcurrencyStore {
  #cached: PipenzoConcurrencySettingsV1 | undefined;
  /** Serializes concurrent writes, exactly as `ConnectedReposStore#writeTail` does -- see its own
   *  comment on why two overlapping renames must never interleave. */
  #writeTail: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  /** The current settings. Cached after the first read, with the same re-check-after-load guard
   *  `ConnectedReposStore.read()` uses: a write landing while a cold-cache load is in flight must
   *  not have its result clobbered by that load's now-stale answer. */
  async read(): Promise<PipenzoConcurrencySettingsV1> {
    if (this.#cached) return this.#cached;
    const loaded = await this.#load();
    if (this.#cached) return this.#cached;
    this.#cached = loaded;
    return this.#cached;
  }

  /**
   * Merges a partial update onto the current settings and persists the result -- see the shared
   * schema's own comment on why this is a merge, not a whole-record replace.
   */
  async update(input: PipenzoConcurrencySettingsUpdateV1): Promise<PipenzoConcurrencySettingsV1> {
    const current = await this.read();
    const next = pipenzoConcurrencySettingsV1Schema.parse({
      schemaVersion: 1,
      executionLimit: input.executionLimit ?? current.executionLimit,
      runBudget: input.runBudget ?? current.runBudget,
    });
    const write = this.#writeTail.then(() => this.#persist(next));
    // `catch` on the tail only: the returned promise must still reject for this caller.
    this.#writeTail = write.catch(() => undefined);
    await write;
    this.#cached = next;
    return next;
  }

  async #load(): Promise<PipenzoConcurrencySettingsV1> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch {
      // No file yet is the ordinary first-run answer, not a failure.
      return DEFAULT_SETTINGS;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<ConcurrencySettingsFileV1>;
      if (parsed.version !== 1) return DEFAULT_SETTINGS;
      return pipenzoConcurrencySettingsV1Schema.parse({
        schemaVersion: 1,
        executionLimit: parsed.executionLimit ?? DEFAULT_SETTINGS.executionLimit,
        runBudget: parsed.runBudget ?? DEFAULT_SETTINGS.runBudget,
      });
    } catch {
      // See the module comment: an unreadable settings file is "never configured", never a locked
      // door -- the next successful write replaces it.
      return DEFAULT_SETTINGS;
    }
  }

  /** Temp file, fsync, rename, fsync the directory -- the same durability every other Pipenzo
   *  single-file store in this codebase uses. */
  async #persist(value: PipenzoConcurrencySettingsV1): Promise<void> {
    const directory = dirname(this.filePath);
    await ensureStateDirectory(directory);
    const temporaryPath = join(directory, `.concurrency-${randomUUID()}.tmp`);
    let renamed = false;
    try {
      const handle = await open(temporaryPath, 'wx', 0o600);
      try {
        const payload: ConcurrencySettingsFileV1 = {
          version: 1,
          executionLimit: value.executionLimit,
          runBudget: value.runBudget,
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
