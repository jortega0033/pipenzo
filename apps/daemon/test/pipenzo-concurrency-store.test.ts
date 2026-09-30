import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PipenzoConcurrencyStore } from '../src/pipenzo-concurrency-store.js';

let directory: string;
let filePath: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'pipenzo-concurrency-'));
  filePath = join(directory, 'concurrency-v1.json');
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true }).catch(() => undefined);
});

describe('PipenzoConcurrencyStore', () => {
  it('answers the product defaults before anything has been configured', async () => {
    expect(await new PipenzoConcurrencyStore(filePath).read()).toEqual({
      schemaVersion: 1,
      executionLimit: 2,
      runBudget: 'unlimited',
    });
  });

  it('round-trips an execution-limit update through a real file', async () => {
    const store = new PipenzoConcurrencyStore(filePath);
    const saved = await store.update({ executionLimit: 4 });

    expect(saved).toEqual({ schemaVersion: 1, executionLimit: 4, runBudget: 'unlimited' });
    // Read back through a *new* instance, so this is the file rather than the cache.
    expect(await new PipenzoConcurrencyStore(filePath).read()).toEqual(saved);
  });

  it('round-trips a run-budget update through a real file', async () => {
    const store = new PipenzoConcurrencyStore(filePath);
    const saved = await store.update({ runBudget: 'three_runs' });

    expect(saved).toEqual({ schemaVersion: 1, executionLimit: 2, runBudget: 'three_runs' });
    expect(await new PipenzoConcurrencyStore(filePath).read()).toEqual(saved);
  });

  it('merges a partial update onto the current settings rather than replacing the whole record', async () => {
    const store = new PipenzoConcurrencyStore(filePath);
    await store.update({ executionLimit: 3 });
    // Only runBudget is given here -- executionLimit must survive unchanged.
    const saved = await store.update({ runBudget: 'cap_200k_tokens' });
    expect(saved).toEqual({ schemaVersion: 1, executionLimit: 3, runBudget: 'cap_200k_tokens' });
  });

  it('rejects an execution limit outside the 1..4 bound', async () => {
    const store = new PipenzoConcurrencyStore(filePath);
    await expect(store.update({ executionLimit: 0 })).rejects.toThrow();
    await expect(store.update({ executionLimit: 5 })).rejects.toThrow();
  });

  it('reads a missing file as the defaults, not an error', async () => {
    expect(await new PipenzoConcurrencyStore(filePath).read()).toEqual({
      schemaVersion: 1,
      executionLimit: 2,
      runBudget: 'unlimited',
    });
  });

  it('reads a corrupt file as the defaults, never a locked door', async () => {
    await writeFile(filePath, 'not json at all', 'utf8');
    expect(await new PipenzoConcurrencyStore(filePath).read()).toEqual({
      schemaVersion: 1,
      executionLimit: 2,
      runBudget: 'unlimited',
    });
  });

  it('reads a file with an unrecognised version as the defaults', async () => {
    await writeFile(filePath, JSON.stringify({ version: 2, executionLimit: 4 }), 'utf8');
    expect(await new PipenzoConcurrencyStore(filePath).read()).toEqual({
      schemaVersion: 1,
      executionLimit: 2,
      runBudget: 'unlimited',
    });
  });

  it('persists durably: the on-disk file round-trips through a fresh readFile, not just the cache', async () => {
    await new PipenzoConcurrencyStore(filePath).update({ executionLimit: 1 });
    const raw = JSON.parse(await readFile(filePath, 'utf8'));
    expect(raw).toEqual({ version: 1, executionLimit: 1, runBudget: 'unlimited' });
  });
});
