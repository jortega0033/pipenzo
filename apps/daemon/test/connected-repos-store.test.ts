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

  /** Two picker submissions must not interleave their renames and leave a half-written file. */
  it('serialises concurrent writes', async () => {
    const store = new ConnectedReposStore(filePath);
    await Promise.all([
      store.replace(['octocat/a']),
      store.replace(['octocat/b']),
      store.replace(['octocat/c']),
    ]);

    const settled = await new ConnectedReposStore(filePath).read();
    // Whichever won, the file is exactly one of the three -- never a mixture, never truncated.
    expect([['octocat/a'], ['octocat/b'], ['octocat/c']]).toContainEqual(settled.repositories);
  });

  it('leaves no temporary files behind', async () => {
    const store = new ConnectedReposStore(filePath);
    await store.replace(['octocat/a']);
    await store.replace(['octocat/b']);

    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(directory);
    expect(entries.filter((name) => name.endsWith('.tmp'))).toEqual([]);
    expect(entries).toContain('connected-repos-v1.json');
  });

  it('writes a versioned envelope, so a future shape change is a new number', async () => {
    await new ConnectedReposStore(filePath).replace(['octocat/a']);
    const parsed = JSON.parse(await readFile(filePath, 'utf8')) as Record<string, unknown>;
    expect(parsed.version).toBe(1);
    expect(parsed.repositories).toEqual(['octocat/a']);
  });
});
