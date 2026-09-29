import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { NewPipenzoAuditEntryV1 } from '@agent-dock/shared';
import { PipenzoAuditStore, PipenzoAuditStoreCorruptError } from '../src/pipenzo-audit-store.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function auditPath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'pipenzo-audit-'));
  temporaryDirectories.push(root);
  return join(root, 'pipenzo-audit-v1.jsonl');
}

function divergenceEntry(overrides: Partial<NewPipenzoAuditEntryV1> = {}): NewPipenzoAuditEntryV1 {
  return {
    ticketId: randomUUID(),
    kind: 'ticket_divergence',
    divergence: 'lane_reconciled',
    previousLane: 'working',
    reconciledLane: 'ready-for-review',
    observedLabels: ['pipenzo:ready-for-review'],
    outcome: 'reconciled_to_label',
    ...overrides,
  };
}

describe('PipenzoAuditStore', () => {
  it('serializes concurrent durable appends and reloads them, oldest first', async () => {
    const path = await auditPath();
    const store = new PipenzoAuditStore(path);
    const ticketId = randomUUID();
    const written = await Promise.all([
      store.append(divergenceEntry({ ticketId })),
      store.append(divergenceEntry({ ticketId })),
      store.append(divergenceEntry()),
    ]);

    expect(written.map((entry) => entry.sequence)).toEqual([0, 1, 2]);
    // Every entry gets its own id and a recorded timestamp, assigned by the store rather than left
    // to the caller.
    expect(new Set(written.map((entry) => entry.entryId)).size).toBe(3);
    expect(written.every((entry) => typeof entry.recordedAt === 'number')).toBe(true);

    const reloaded = new PipenzoAuditStore(path);
    const all = await reloaded.list();
    expect(all).toHaveLength(3);
    expect(all.map((entry) => entry.sequence)).toEqual([0, 1, 2]);

    const scoped = await reloaded.list({ ticketId });
    expect(scoped).toHaveLength(2);
    expect(scoped.every((entry) => entry.ticketId === ticketId)).toBe(true);
  });

  it('fills in schemaVersion/sequence/entryId/recordedAt and keeps the caller-supplied fields', async () => {
    const path = await auditPath();
    const fixedEntryId = randomUUID();
    const store = new PipenzoAuditStore(path, {
      now: () => 1_700_000_000_000,
      randomEntryId: () => fixedEntryId,
    });

    const entry = await store.append(divergenceEntry({ divergence: 'ambiguous_labels' }));

    expect(entry).toMatchObject({
      schemaVersion: 1,
      sequence: 0,
      entryId: fixedEntryId,
      recordedAt: 1_700_000_000_000,
      kind: 'ticket_divergence',
      divergence: 'ambiguous_labels',
      outcome: 'reconciled_to_label',
    });
  });

  it('treats an absent file as an empty log rather than an error', async () => {
    const path = await auditPath();
    const store = new PipenzoAuditStore(path);
    await expect(store.list()).resolves.toEqual([]);
  });

  it('fails closed on a non-contiguous sequence instead of silently under-reporting', async () => {
    const path = await auditPath();
    const first = divergenceEntry();
    const second = divergenceEntry();
    // A hand-written file whose second line's `sequence` skips from 0 to 2 -- the shape a torn or
    // tampered write would leave behind.
    await writeFile(
      path,
      [
        JSON.stringify({
          schemaVersion: 1,
          sequence: 0,
          entryId: randomUUID(),
          recordedAt: 1,
          ...first,
        }),
        JSON.stringify({
          schemaVersion: 1,
          sequence: 2,
          entryId: randomUUID(),
          recordedAt: 2,
          ...second,
        }),
      ].join('\n') + '\n',
      'utf8',
    );

    const store = new PipenzoAuditStore(path);
    await expect(store.list()).rejects.toBeInstanceOf(PipenzoAuditStoreCorruptError);
    // A corrupt store fails closed on every later call too, not just the first.
    await expect(store.append(divergenceEntry())).rejects.toBeInstanceOf(
      PipenzoAuditStoreCorruptError,
    );
  });
});
