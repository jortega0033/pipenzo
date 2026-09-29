import { randomUUID } from 'node:crypto';
import { open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  PIPENZO_MAX_LESSONS,
  pipenzoLessonListV1Schema,
  pipenzoLessonV1Schema,
  type PipenzoLessonCreateV1,
  type PipenzoLessonListV1,
  type PipenzoLessonV1,
} from '@agent-dock/shared';
import { ensureStateDirectory } from './state-directory.js';

/**
 * A rename is only durable once the *directory* entry is on disk, not just the file's contents.
 *
 * Copied rather than imported — `connected-repos-store.ts` carries the same private copy for the
 * same documented reason (see its own comment): the honest fix is a shared `durable-write.ts`, which
 * is a refactor of several call sites, not something to smuggle into this store.
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
 * Local, human-gated lesson memory (Pipenzo issue #18): where a saved lesson actually lives.
 *
 * ## One file, not `FileTicketStore`'s per-record layout
 *
 * `pipenzo-ticket-store.ts` keeps one file per ticket because a ticket record is written often (a
 * label observed, a session dispatched) and has to survive the daemon crashing mid-write to *that
 * one ticket* without disturbing every other ticket's file. A lesson is nothing like that: it is
 * written once, by a person, at the moment they click "Save lesson", and the whole *point* of the
 * feature is that the list is short — "1 lesson across 3 connected repos" is the design canvas's own
 * example. `ConnectedReposStore` is the closer relative: a single small JSON file, replaced whole on
 * each write, with the same temp-file/fsync/rename/fsync-directory durability. This store follows it
 * file-for-file rather than re-deriving the same durability primitives a third time.
 *
 * ## Why `list()`/`add()`/`remove()`, not `replace()`
 *
 * `ConnectedReposStore.replace()` fits a picker whose checkboxes describe the complete selection.
 * Lessons are the opposite shape: `add()` is one save (issue #104's "Save lesson" button, wired to
 * this store's `create()` counterpart once that ticket lands), and `remove()` is one per-item delete
 * (issue #128's Settings row) — "it is not an index", so removing one lesson must never require
 * resending every other one.
 *
 * ## Why a corrupt file reads as an empty list, exactly like `ConnectedReposStore`
 *
 * The same reasoning applies: a lesson list that failed to parse should not turn Settings' lesson
 * panel into a screen that cannot load. "No lessons" is the honest, safe fallback — the corrupt file
 * is replaced by the next successful write, and nothing a person saved before is claimed to still be
 * there when it cannot be read.
 */

interface LessonsFileV1 {
  readonly version: 1;
  readonly lessons: readonly PipenzoLessonV1[];
}

const EMPTY: PipenzoLessonListV1 = { lessons: [] };

export type LessonStoreErrorCode = 'too_many_lessons' | 'lesson_not_found';

export class LessonStoreError extends Error {
  readonly code: LessonStoreErrorCode;

  constructor(code: LessonStoreErrorCode, message: string) {
    super(message);
    this.name = 'LessonStoreError';
    this.code = code;
  }
}

export class LessonStore {
  #cached: PipenzoLessonListV1 | undefined;
  /** Serializes concurrent writes, exactly as `ConnectedReposStore#writeTail` does — see its own
   *  comment on why two overlapping renames must never interleave. */
  #writeTail: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  /** The current list, newest-saved first — the order Settings' panel renders in. Cached after the
   *  first read, with the same re-check-after-load guard `ConnectedReposStore.read()` uses: a write
   *  landing while a cold-cache load is in flight must not have its result clobbered by that load's
   *  now-stale answer. */
  async list(): Promise<PipenzoLessonListV1> {
    if (this.#cached) return this.#cached;
    const loaded = await this.#load();
    if (this.#cached) return this.#cached;
    this.#cached = loaded;
    return this.#cached;
  }

  /** Saves one lesson and returns it. Not reachable from any route yet — issue #104 is what wires
   *  `LessonPrompt`'s "Save lesson" to this method; it exists now so that ticket has a store to call
   *  rather than one it has to design from scratch, and so this store's own tests can seed data
   *  without reaching around the public API to write a file by hand. */
  async add(input: PipenzoLessonCreateV1): Promise<PipenzoLessonV1> {
    return this.#mutate((current) => {
      if (current.lessons.length >= PIPENZO_MAX_LESSONS) {
        throw new LessonStoreError(
          'too_many_lessons',
          `at most ${PIPENZO_MAX_LESSONS} lessons can be saved`,
        );
      }
      const lesson = pipenzoLessonV1Schema.parse({
        schemaVersion: 1,
        id: randomUUID(),
        repo: input.repo,
        issueNumber: input.issueNumber,
        text: input.text,
        savedAt: new Date().toISOString(),
      });
      return { result: lesson, next: { lessons: [lesson, ...current.lessons] } };
    });
  }

  /**
   * Removes one lesson by id and returns the list afterward — the daemon's own answer, not a
   * filtered view the caller assembled, matching `ConnectedReposPanel.remove()`'s reasoning for why
   * a renderer should render what actually landed rather than what it optimistically assumed would.
   *
   * Deleting a lesson "breaks nothing" (issue #128's own acceptance note): this is a plain removal
   * from a flat list, never a compaction, a reindex, or a rewrite of any other entry.
   */
  async remove(id: string): Promise<PipenzoLessonListV1> {
    return this.#mutate((current) => {
      if (!current.lessons.some((lesson) => lesson.id === id)) {
        throw new LessonStoreError('lesson_not_found', `no saved lesson with id ${id}`);
      }
      const next: PipenzoLessonListV1 = {
        lessons: current.lessons.filter((lesson) => lesson.id !== id),
      };
      return { result: next, next };
    });
  }

  async #load(): Promise<PipenzoLessonListV1> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch {
      // No file yet is the ordinary "nothing saved" answer, not a failure.
      return EMPTY;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<LessonsFileV1>;
      if (parsed.version !== 1) return EMPTY;
      return pipenzoLessonListV1Schema.parse({ lessons: parsed.lessons ?? [] });
    } catch {
      return EMPTY;
    }
  }

  /**
   * Runs one read-modify-write step of the list, serialized against every other `#mutate` call
   * through `#writeTail` — exactly like `ConnectedReposStore#writeTail`, but for a different race.
   * `ConnectedReposStore.replace()` takes the *complete* next list from its caller, so two
   * overlapping replaces only need to agree on which one lands last. `add`/`remove` instead each
   * compute their next list *from the current one*, so if `mutator` ran against a snapshot taken
   * before an earlier call's write had landed, two concurrent saves would each build their own
   * one-lesson-longer list from the same starting point and the second write would silently discard
   * the first — the exact bug this store's own tests caught before this comment existed. Reading
   * `current` from inside the queued step (rather than before it is queued) is what fixes that: by
   * the time this callback runs, every earlier `#mutate` in the chain has already persisted and
   * updated `#cached`, so `this.list()` here always reflects them.
   */
  async #mutate<T>(
    mutator: (current: PipenzoLessonListV1) => { result: T; next: PipenzoLessonListV1 },
  ): Promise<T> {
    const write = this.#writeTail.then(async () => {
      const current = await this.list();
      const { result, next } = mutator(current);
      // Validated on the way in, so a bad value fails here rather than becoming a file every later
      // read has to cope with.
      const parsed = pipenzoLessonListV1Schema.parse(next);
      await this.#persist(parsed);
      this.#cached = parsed;
      return result;
    });
    // `catch` on the tail only: the returned promise must still reject for this caller.
    this.#writeTail = write.then(
      () => undefined,
      () => undefined,
    );
    return write;
  }

  /** Temp file, fsync, rename, fsync the directory — the same durability `ConnectedReposStore` uses. */
  async #persist(value: PipenzoLessonListV1): Promise<void> {
    const directory = dirname(this.filePath);
    await ensureStateDirectory(directory);
    const temporaryPath = join(directory, `.lessons-${randomUUID()}.tmp`);
    let renamed = false;
    try {
      const handle = await open(temporaryPath, 'wx', 0o600);
      try {
        const payload: LessonsFileV1 = { version: 1, lessons: value.lessons };
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
