import { randomUUID } from 'node:crypto';
import { open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  PIPENZO_ESCAPE_HATCH_ENABLED_DEFAULT,
  PIPENZO_SCREENSHOT_ENABLED_DEFAULT,
  pipenzoCaptureSettingsV1Schema,
  type PipenzoCaptureSettingsUpdateV1,
  type PipenzoCaptureSettingsV1,
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
 * The Models & gates screen's agent-captured panel (Pipenzo issue #470, the same split of scope
 * #126 already drew for bounded concurrency): the `screenshotEnabled`/`escapeHatchEnabled` state
 * behind `AgentCapturedPanel`'s two real toggles, persisted beside the other durable stores -- one
 * file per daemon state directory, not one per workspace or per repository. See
 * `pipenzo-capture-settings-v1.ts`'s own module comment for why this is workspace-level rather
 * than keyed by repository, and for what this store deliberately does not yet do.
 *
 * A missing or corrupt file reads as the product defaults (`screenshotEnabled: true`,
 * `escapeHatchEnabled: false`, matching `Models.dc.html`'s own seeded state), never as an error --
 * same "never configured, not a locked door" reasoning `PipenzoConcurrencyStore`'s own comment
 * states for the same shape of store.
 */

/** The on-disk envelope. Versioned so a future shape change is a new number, not a guess. */
interface CaptureSettingsFileV1 {
  readonly version: 1;
  readonly screenshotEnabled: boolean;
  readonly escapeHatchEnabled: boolean;
}

const DEFAULT_SETTINGS: PipenzoCaptureSettingsV1 = {
  schemaVersion: 1,
  screenshotEnabled: PIPENZO_SCREENSHOT_ENABLED_DEFAULT,
  escapeHatchEnabled: PIPENZO_ESCAPE_HATCH_ENABLED_DEFAULT,
};

export class PipenzoCaptureSettingsStore {
  #cached: PipenzoCaptureSettingsV1 | undefined;
  /** Serializes concurrent writes, exactly as `PipenzoConcurrencyStore#writeTail` does -- see its
   *  own comment on why two overlapping renames must never interleave. */
  #writeTail: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  /** The current settings. Cached after the first read, with the same re-check-after-load guard
   *  `PipenzoConcurrencyStore.read()` uses: a write landing while a cold-cache load is in flight
   *  must not have its result clobbered by that load's now-stale answer. */
  async read(): Promise<PipenzoCaptureSettingsV1> {
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
  async update(input: PipenzoCaptureSettingsUpdateV1): Promise<PipenzoCaptureSettingsV1> {
    const current = await this.read();
    const next = pipenzoCaptureSettingsV1Schema.parse({
      schemaVersion: 1,
      screenshotEnabled: input.screenshotEnabled ?? current.screenshotEnabled,
      escapeHatchEnabled: input.escapeHatchEnabled ?? current.escapeHatchEnabled,
    });
    const write = this.#writeTail.then(() => this.#persist(next));
    // `catch` on the tail only: the returned promise must still reject for this caller.
    this.#writeTail = write.catch(() => undefined);
    await write;
    this.#cached = next;
    return next;
  }

  async #load(): Promise<PipenzoCaptureSettingsV1> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch {
      // No file yet is the ordinary first-run answer, not a failure.
      return DEFAULT_SETTINGS;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<CaptureSettingsFileV1>;
      if (parsed.version !== 1) return DEFAULT_SETTINGS;
      return pipenzoCaptureSettingsV1Schema.parse({
        schemaVersion: 1,
        screenshotEnabled: parsed.screenshotEnabled ?? DEFAULT_SETTINGS.screenshotEnabled,
        escapeHatchEnabled: parsed.escapeHatchEnabled ?? DEFAULT_SETTINGS.escapeHatchEnabled,
      });
    } catch {
      // See the module comment: an unreadable settings file is "never configured", never a locked
      // door -- the next successful write replaces it.
      return DEFAULT_SETTINGS;
    }
  }

  /** Temp file, fsync, rename, fsync the directory -- the same durability every other Pipenzo
   *  single-file store in this codebase uses. */
  async #persist(value: PipenzoCaptureSettingsV1): Promise<void> {
    const directory = dirname(this.filePath);
    await ensureStateDirectory(directory);
    const temporaryPath = join(directory, `.capture-settings-${randomUUID()}.tmp`);
    let renamed = false;
    try {
      const handle = await open(temporaryPath, 'wx', 0o600);
      try {
        const payload: CaptureSettingsFileV1 = {
          version: 1,
          screenshotEnabled: value.screenshotEnabled,
          escapeHatchEnabled: value.escapeHatchEnabled,
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
