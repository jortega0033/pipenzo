import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ConnectedReposStore,
  ConnectedReposStoreError,
} from '../src/connected-repos-store.js';

let directory: string;
let filePath: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'pipenzo-connected-repos-'));
  filePath = join(directory, 'connected-repos-v1.json');
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true }).catch(() => undefined);
});

describe('ConnectedReposStore', () => {
  it('answers an empty list before anything has been chosen', async () => {
    expect(await new ConnectedReposStore(filePath).read()).toEqual({ repositories: [] });
  });

  it('round-trips a selection through a real file', async () => {
    const store = new ConnectedReposStore(filePath);
    const saved = await store.replace(['octocat/hello-world', 'octocat/spoon-knife']);

    expect(saved.repositories).toEqual(['octocat/hello-world', 'octocat/spoon-knife']);
    expect(saved.updatedAt).toBeTypeOf('string');
    // Read back through a *new* instance, so this is the file rather than the cache.
    expect((await new ConnectedReposStore(filePath).read()).repositories).toEqual([
      'octocat/hello-world',
      'octocat/spoon-knife',
    ]);
  });

  /**
   * Sorted rather than kept in click order. This file is read back by a reconciler that iterates
   * it, and an order that depends on which checkbox was ticked first makes two identical selections
   * produce two different files.
   */
  it('stores a stable, de-duplicated order whatever order it was given', async () => {
    const store = new ConnectedReposStore(filePath);
    const saved = await store.replace([
      'octocat/zebra',
      'octocat/apple',
      'octocat/zebra',
      'octocat/apple',
    ]);
    expect(saved.repositories).toEqual(['octocat/apple', 'octocat/zebra']);
  });

  it('replaces the list rather than adding to it', async () => {
    const store = new ConnectedReposStore(filePath);
    await store.replace(['octocat/a', 'octocat/b']);
    // Unticking a box has to mean something.
    expect((await store.replace(['octocat/b'])).repositories).toEqual(['octocat/b']);
    expect((await new ConnectedReposStore(filePath).read()).repositories).toEqual(['octocat/b']);
  });

  it('accepts an empty list, which is how the last repository is removed', async () => {
    const store = new ConnectedReposStore(filePath);
    await store.replace(['octocat/a']);
    expect((await store.replace([])).repositories).toEqual([]);
  });

  /** De-duplication happens *before* the cap, so repeating one repository is not a rejection. */
  it('refuses more repositories than the reconciler should be asked to poll', async () => {
    const store = new ConnectedReposStore(filePath);
    const many = Array.from({ length: 51 }, (_, index) => `octocat/repo-${index}`);
    await expect(store.replace(many)).rejects.toBeInstanceOf(ConnectedReposStoreError);

    const duplicated = Array.from({ length: 60 }, () => 'octocat/one');
    expect((await store.replace(duplicated)).repositories).toEqual(['octocat/one']);
  });

  /**
   * A corrupt state file must not lock an installation out of the screen that would fix it. This
   * store answers a question that gates the pre-app -- "has anyone chosen repositories yet?" -- so
   * "none yet" puts the user back in the picker, and the next write replaces the bad file.
   */
  it('reads a corrupt or foreign file as an empty list rather than throwing', async () => {
    for (const contents of [
      'not json at all',
      JSON.stringify({ version: 2, repositories: ['octocat/a'] }),
      JSON.stringify({ version: 1, repositories: ['not a repo ref'] }),
      JSON.stringify({ version: 1, repositories: 'octocat/a' }),
      '',
    ]) {
      await writeFile(filePath, contents, 'utf8');
      expect(await new ConnectedReposStore(filePath).read()).toEqual({ repositories: [] });
    }

    // ...and is replaced by the next successful write.
    await new ConnectedReposStore(filePath).replace(['octocat/a']);
    expect((await new ConnectedReposStore(filePath).read()).repositories).toEqual(['octocat/a']);
  });

  it('refuses a value that is not owner/name', async () => {
    const store = new ConnectedReposStore(filePath);
    for (const bad of ['no-slash', '/leading', 'trailing/', 'a b/c', '../../etc/passwd']) {
      await expect(store.replace([bad])).rejects.toBeTruthy();
    }
    // And nothing was written on the way through.
    expect(await new ConnectedReposStore(filePath).read()).toEqual({ repositories: [] });
  });

  /**
   * The property serialisation actually buys.
   *
   * An earlier version of this test asserted only that the file was "one of the three, never a
   * mixture" — which the unique-temp-file-plus-atomic-rename scheme guarantees on its own, so it
   * passed with `#writeTail` deleted entirely. What the chain is for is *ordering*: the last write
   * issued is the one on disk afterwards, and the cache agrees with it.
   */
  it('serialises concurrent writes, so the last one issued is the one that survives', async () => {
    const store = new ConnectedReposStore(filePath);
    await Promise.all([
      store.replace(['octocat/a']),
      store.replace(['octocat/b']),
      store.replace(['octocat/c']),
    ]);

    expect((await new ConnectedReposStore(filePath).read()).repositories).toEqual(['octocat/c']);
    // ...and the in-memory answer is not a different one from the file's.
    expect((await store.read()).repositories).toEqual(['octocat/c']);
  });

  /**
   * `GET` and `PUT` are independent requests, so a cold-cache read can be in flight while a write
   * lands. Without the re-check after the load, the load's pre-rename answer overwrote the value
   * the write had just cached — and every later read served a list older than the file for the life
   * of the process, which the gate reads as "no repositories chosen".
   */
  it('does not let a read that overlapped a write serve a stale answer', async () => {
    const store = new ConnectedReposStore(filePath);
    // Started first, against a file that does not exist yet.
    const reading = store.read();
    await store.replace(['octocat/a']);
    await reading;

    expect((await store.read()).repositories).toEqual(['octocat/a']);
  });

  it('leaves the cache alone when a write fails', async () => {
    const store = new ConnectedReposStore(filePath);
    await store.replace(['octocat/a']);
    await expect(store.replace(['not a repo ref'])).rejects.toBeTruthy();
    // The failed write must not be able to claim a list that never landed.
    expect((await store.read()).repositories).toEqual(['octocat/a']);
  });

  it('leaves no temporary files behind on the happy path', async () => {
    const store = new ConnectedReposStore(filePath);
    await store.replace(['octocat/a']);
    await store.replace(['octocat/b']);

    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(directory);
    expect(entries.filter((name) => name.endsWith('.tmp'))).toEqual([]);
    expect(entries).toContain('connected-repos-v1.json');
  });

  /**
   * The path the previous test could not reach: on success the rename consumes the temporary file,
   * so the `finally` that unlinks it never runs and could be deleted unnoticed. A write into a
   * directory that cannot be created fails before the rename, which is where the cleanup matters.
   */
  it('leaves no temporary file behind when the write itself fails', async () => {
    const { writeFile, readdir } = await import('node:fs/promises');
    // A *file* where the store expects a directory: `ensureStateDirectory` fails, so `#persist`
    // throws before it can create anything -- and nothing is left over.
    const blocked = join(directory, 'blocked');
    await writeFile(blocked, 'not a directory', 'utf8');
    const store = new ConnectedReposStore(join(blocked, 'connected-repos-v1.json'));

    await expect(store.replace(['octocat/a'])).rejects.toBeTruthy();
    expect((await readdir(directory)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('writes a versioned envelope, so a future shape change is a new number', async () => {
    await new ConnectedReposStore(filePath).replace(['octocat/a']);
    const parsed = JSON.parse(await readFile(filePath, 'utf8')) as Record<string, unknown>;
    expect(parsed.version).toBe(1);
    expect(parsed.repositories).toEqual(['octocat/a']);
  });
});
