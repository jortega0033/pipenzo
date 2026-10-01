import { randomUUID } from 'node:crypto';
import { open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  PIPENZO_NOTIFY_BADGE_DEFAULT,
  PIPENZO_NOTIFY_MEDIUM_DEFAULT,
  PIPENZO_NOTIFY_REFUSAL_DEFAULT,
  PIPENZO_NOTIFY_SOUND_DEFAULT,
  pipenzoNotificationSettingsV1Schema,
  type PipenzoNotificationSettingsUpdateV1,
  type PipenzoNotificationSettingsV1,
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
 * Settings' Notifications panel (Pipenzo issue #129): the four switchable rows'
 * `refusal`/`medium`/`badge`/`sound` preferences, persisted beside the other durable stores -- one
 * file per daemon state directory, not one per workspace or per repository, same shape
 * `PipenzoConcurrencyStore` and `PipenzoCaptureSettingsStore` already use for the same reason.
 *
 * There is deliberately no fifth field for HIGH-risk approvals -- see
 * `pipenzo-notification-settings-v1.ts`'s own module comment. This store cannot persist a "HIGH
 * off" state because the schema it validates against has no slot for one.
 *
 * A missing or corrupt file reads as the product defaults (`refusal: true, medium: true, badge:
 * true, sound: false`, matching `Settings.dc.html`'s own seeded state), never as an error -- same
 * "never configured, not a locked door" reasoning `PipenzoConcurrencyStore`'s own comment states for
 * the same shape of store.
 */

/** The on-disk envelope. Versioned so a future shape change is a new number, not a guess. */
interface NotificationSettingsFileV1 {
  readonly version: 1;
  readonly refusal: boolean;
  readonly medium: boolean;
  readonly badge: boolean;
  readonly sound: boolean;
}

const DEFAULT_SETTINGS: PipenzoNotificationSettingsV1 = {
  schemaVersion: 1,
  refusal: PIPENZO_NOTIFY_REFUSAL_DEFAULT,
  medium: PIPENZO_NOTIFY_MEDIUM_DEFAULT,
  badge: PIPENZO_NOTIFY_BADGE_DEFAULT,
  sound: PIPENZO_NOTIFY_SOUND_DEFAULT,
};

export class PipenzoNotificationSettingsStore {
  #cached: PipenzoNotificationSettingsV1 | undefined;
  /** Serializes concurrent writes, exactly as `PipenzoConcurrencyStore#writeTail` does -- see its
   *  own comment on why two overlapping renames must never interleave. */
  #writeTail: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  /** The current settings. Cached after the first read, with the same re-check-after-load guard
   *  `PipenzoConcurrencyStore.read()` uses: a write landing while a cold-cache load is in flight
   *  must not have its result clobbered by that load's now-stale answer. */
  async read(): Promise<PipenzoNotificationSettingsV1> {
    if (this.#cached) return this.#cached;
    const loaded = await this.#load();
    if (this.#cached) return this.#cached;
    this.#cached = loaded;
    return this.#cached;
  }

  /**
   * Merges a partial update onto the current settings and persists the result -- see the shared
   * schema's own comment on why this is a merge, not a whole-record replace. `input` is already
   * `pipenzoNotificationSettingsUpdateV1Schema`-shaped, so there is no `high` field it could ever
   * carry.
   */
  async update(
    input: PipenzoNotificationSettingsUpdateV1,
  ): Promise<PipenzoNotificationSettingsV1> {
    const current = await this.read();
    const next = pipenzoNotificationSettingsV1Schema.parse({
      schemaVersion: 1,
      refusal: input.refusal ?? current.refusal,
      medium: input.medium ?? current.medium,
      badge: input.badge ?? current.badge,
      sound: input.sound ?? current.sound,
    });
    const write = this.#writeTail.then(() => this.#persist(next));
    // `catch` on the tail only: the returned promise must still reject for this caller.
    this.#writeTail = write.catch(() => undefined);
    await write;
    this.#cached = next;
    return next;
  }

  async #load(): Promise<PipenzoNotificationSettingsV1> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch {
      // No file yet is the ordinary first-run answer, not a failure.
      return DEFAULT_SETTINGS;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<NotificationSettingsFileV1>;
      if (parsed.version !== 1) return DEFAULT_SETTINGS;
      return pipenzoNotificationSettingsV1Schema.parse({
        schemaVersion: 1,
        refusal: parsed.refusal ?? DEFAULT_SETTINGS.refusal,
        medium: parsed.medium ?? DEFAULT_SETTINGS.medium,
        badge: parsed.badge ?? DEFAULT_SETTINGS.badge,
        sound: parsed.sound ?? DEFAULT_SETTINGS.sound,
      });
    } catch {
      // See the module comment: an unreadable settings file is "never configured", never a locked
      // door -- the next successful write replaces it.
      return DEFAULT_SETTINGS;
    }
  }

  /** Temp file, fsync, rename, fsync the directory -- the same durability every other Pipenzo
   *  single-file store in this codebase uses. */
  async #persist(value: PipenzoNotificationSettingsV1): Promise<void> {
    const directory = dirname(this.filePath);
    await ensureStateDirectory(directory);
    const temporaryPath = join(directory, `.notification-settings-${randomUUID()}.tmp`);
    let renamed = false;
    try {
      const handle = await open(temporaryPath, 'wx', 0o600);
      try {
        const payload: NotificationSettingsFileV1 = {
          version: 1,
          refusal: value.refusal,
          medium: value.medium,
          badge: value.badge,
          sound: value.sound,
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
