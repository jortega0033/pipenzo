import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PIPENZO_MAX_LESSONS } from '@agent-dock/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LessonStore, LessonStoreError } from '../src/pipenzo-lesson-store.js';

let directory: string;
let filePath: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'pipenzo-lessons-'));
  filePath = join(directory, 'lessons-v1.json');
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true }).catch(() => undefined);
});

const SAMPLE = {
  repo: 'octocat/hello-world',
  issueNumber: 94,
  text: 'On Windows the host sets Path, not PATH.',
};

describe('LessonStore', () => {
  it('answers an empty list before anything has been saved', async () => {
    expect(await new LessonStore(filePath).list()).toEqual({ lessons: [] });
  });

  it('round-trips a saved lesson through a real file', async () => {
    const store = new LessonStore(filePath);
    const saved = await store.add(SAMPLE);

    expect(saved.repo).toBe(SAMPLE.repo);
    expect(saved.issueNumber).toBe(SAMPLE.issueNumber);
    expect(saved.text).toBe(SAMPLE.text);
    expect(saved.id).toBeTypeOf('string');
    expect(saved.savedAt).toBeTypeOf('string');
    // Read back through a *new* instance, so this is the file rather than the cache.
    expect((await new LessonStore(filePath).list()).lessons).toEqual([saved]);
  });

  it('lists newest-saved first', async () => {
    const store = new LessonStore(filePath);
    const first = await store.add(SAMPLE);
    const second = await store.add({ ...SAMPLE, text: 'A second lesson.' });
    expect((await store.list()).lessons.map((lesson) => lesson.id)).toEqual([second.id, first.id]);
  });

  it('deletes exactly the named lesson and leaves the rest untouched', async () => {
    const store = new LessonStore(filePath);
    const first = await store.add(SAMPLE);
    const second = await store.add({ ...SAMPLE, text: 'A second lesson.' });

    const after = await store.remove(first.id);
    expect(after.lessons).toEqual([second]);
    expect((await new LessonStore(filePath).list()).lessons).toEqual([second]);
  });

  it('refuses to delete a lesson that does not exist', async () => {
    const store = new LessonStore(filePath);
    await store.add(SAMPLE);
    await expect(store.remove('12345678-1234-4234-8234-123456789abc')).rejects.toBeInstanceOf(
      LessonStoreError,
    );
  });

  // Seeds the file directly rather than performing PIPENZO_MAX_LESSONS real, sequential fsync'd
  // writes: 500 of those is genuinely slower than a CI runner's budget under load (this store's own
  // durability -- temp file, fsync, rename, fsync the directory -- is real disk time per write, by
  // design), and the concurrent-write test above already covers the write queue's own correctness.
  // This test's job is only the cap check in `add()`, which reads the list length regardless of how
  // the file got that long -- a direct write exercises exactly that read path.
  it('refuses more lessons than the panel should ever have to list', async () => {
    const full = {
      version: 1 as const,
      lessons: Array.from({ length: PIPENZO_MAX_LESSONS }, (_, index) => ({
        schemaVersion: 1 as const,
        id: randomUUID(),
        repo: SAMPLE.repo,
        issueNumber: SAMPLE.issueNumber,
        text: `lesson ${index}`,
        savedAt: new Date().toISOString(),
      })),
    };
    await writeFile(filePath, JSON.stringify(full), 'utf8');

    const store = new LessonStore(filePath);
    await expect(store.add(SAMPLE)).rejects.toBeInstanceOf(LessonStoreError);
  });

  /**
   * A corrupt state file must not lock Settings' lesson panel out of loading — same reasoning as
   * `ConnectedReposStore`'s equivalent test.
   */
  it('reads a corrupt or foreign file as an empty list rather than throwing', async () => {
    for (const contents of [
      'not json at all',
      JSON.stringify({ version: 2, lessons: [{ text: 'x' }] }),
      JSON.stringify({ version: 1, lessons: 'not an array' }),
      '',
    ]) {
      await writeFile(filePath, contents, 'utf8');
      expect(await new LessonStore(filePath).list()).toEqual({ lessons: [] });
    }

    // ...and is replaced by the next successful write.
    await new LessonStore(filePath).add(SAMPLE);
    expect((await new LessonStore(filePath).list()).lessons).toHaveLength(1);
  });

  it('serialises concurrent writes, so no save is lost to an overlapping one', async () => {
    const store = new LessonStore(filePath);
    await Promise.all([
      store.add({ ...SAMPLE, text: 'a' }),
      store.add({ ...SAMPLE, text: 'b' }),
      store.add({ ...SAMPLE, text: 'c' }),
    ]);

    const texts = (await new LessonStore(filePath).list()).lessons
      .map((lesson) => lesson.text)
      .sort();
    expect(texts).toEqual(['a', 'b', 'c']);
  });

  it('leaves no temporary files behind on the happy path', async () => {
    const store = new LessonStore(filePath);
    const saved = await store.add(SAMPLE);
    await store.remove(saved.id);

    const entries = await readdir(directory);
    expect(entries.filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('writes a versioned envelope, so a future shape change is a new number', async () => {
    await new LessonStore(filePath).add(SAMPLE);
    const parsed = JSON.parse(await readFile(filePath, 'utf8')) as Record<string, unknown>;
    expect(parsed.version).toBe(1);
    expect(Array.isArray(parsed.lessons)).toBe(true);
  });
});
