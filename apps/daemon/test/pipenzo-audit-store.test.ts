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

/** `NewPipenzoAuditEntryV1` is a union (one member per `kind`, issue #160) -- `Partial` of a union
 * type distributes member-by-member, so a builder's own overrides parameter has to be narrowed to
 * its one member with `Extract` rather than `Partial<NewPipenzoAuditEntryV1>` directly, or spreading
 * a same-shaped-but-wrong-kind override back into the base object no longer type-checks cleanly. */
type NewDivergenceEntry = Extract<NewPipenzoAuditEntryV1, { kind: 'ticket_divergence' }>;
type NewPublishEntry = Extract<NewPipenzoAuditEntryV1, { kind: 'publish_result' }>;
type NewReviewGateEntry = Extract<NewPipenzoAuditEntryV1, { kind: 'review_gate_result' }>;

function divergenceEntry(overrides: Partial<NewDivergenceEntry> = {}): NewPipenzoAuditEntryV1 {
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

const HEAD_SHA = 'a'.repeat(40);
const WORKTREE_ID = '11111111-2222-4333-8444-555555555555';

/** A publish-result entry (issue #160), defaulting to the `succeeded` shape. `Partial` rather than
 * the real type on purpose: several tests deliberately build an invalid entry (e.g. a `succeeded`
 * outcome missing `headSha`) to prove the store's own schema rejects it. */
function publishEntry(overrides: Partial<NewPublishEntry> = {}): NewPipenzoAuditEntryV1 {
  return {
    ticketId: randomUUID(),
    kind: 'publish_result',
    outcome: 'succeeded',
    operation: 'push',
    worktreeId: WORKTREE_ID,
    remote: 'origin',
    branch: 'issue-160',
    headSha: HEAD_SHA,
    updatedRemote: true,
    ...overrides,
  };
}

/** A review-gate-result entry (issue #160). */
function reviewGateEntry(overrides: Partial<NewReviewGateEntry> = {}): NewPipenzoAuditEntryV1 {
  return {
    ticketId: randomUUID(),
    kind: 'review_gate_result',
    outcome: 'approved',
    risk: 'low',
    baseCommit: HEAD_SHA,
    headCommit: HEAD_SHA,
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

describe('PipenzoAuditStore — publish_result entries (issue #160)', () => {
  it('appends and reloads a succeeded publish entry', async () => {
    const path = await auditPath();
    const store = new PipenzoAuditStore(path);

    const written = await store.append(publishEntry());
    expect(written).toMatchObject({
      kind: 'publish_result',
      outcome: 'succeeded',
      operation: 'push',
      worktreeId: WORKTREE_ID,
      remote: 'origin',
      headSha: HEAD_SHA,
      updatedRemote: true,
    });

    const reloaded = await new PipenzoAuditStore(path).list();
    expect(reloaded).toEqual([written]);
  });

  it('appends and reloads a succeeded publish entry that opened a pull request', async () => {
    const path = await auditPath();
    const store = new PipenzoAuditStore(path);

    const written = await store.append(
      publishEntry({
        operation: 'push_and_open_pull_request',
        pullRequest: { number: 7, htmlUrl: 'https://github.com/o/r/pull/7', baseRef: 'main', draft: false },
      }),
    );
    expect(written.kind).toBe('publish_result');
    if (written.kind === 'publish_result') {
      expect(written.pullRequest).toEqual({
        number: 7,
        htmlUrl: 'https://github.com/o/r/pull/7',
        baseRef: 'main',
        draft: false,
      });
    }
  });

  it('appends and reloads a failed publish entry', async () => {
    const path = await auditPath();
    const store = new PipenzoAuditStore(path);

    const written = await store.append(
      publishEntry({
        outcome: 'failed',
        headSha: undefined,
        updatedRemote: undefined,
        errorCode: 'push_rejected',
        error: 'git push origin issue-160 failed: rejected',
      }),
    );
    expect(written).toMatchObject({
      outcome: 'failed',
      errorCode: 'push_rejected',
      error: 'git push origin issue-160 failed: rejected',
    });
    expect(written.kind).toBe('publish_result');
    if (written.kind === 'publish_result') {
      expect(written.headSha).toBeUndefined();
    }
  });

  it('rejects a succeeded entry missing its push result, and a failed entry missing its error', async () => {
    const store = new PipenzoAuditStore(await auditPath());
    await expect(
      store.append(publishEntry({ headSha: undefined, updatedRemote: undefined })),
    ).rejects.toThrow();
    await expect(store.append(publishEntry({ outcome: 'failed' }))).rejects.toThrow();
  });

  it('rejects a failed entry that still carries a push/pull-request result', async () => {
    const store = new PipenzoAuditStore(await auditPath());
    await expect(
      store.append(
        publishEntry({ outcome: 'failed', errorCode: 'push_failed', error: 'boom' }),
      ),
    ).rejects.toThrow();
  });
});

describe('PipenzoAuditStore — review_gate_result entries (issue #160)', () => {
  it('appends and reloads a review-gate result for each meaningfully different outcome', async () => {
    const path = await auditPath();
    const store = new PipenzoAuditStore(path);
    const outcomes = [
      'approved',
      'verifier_rejected',
      'deterministic_failed',
      'estimate_blown',
      'awaiting_test_adjudication',
      'review_input_incomplete',
    ] as const;

    for (const outcome of outcomes) {
      const written = await store.append(reviewGateEntry({ outcome }));
      expect(written).toMatchObject({ kind: 'review_gate_result', outcome, risk: 'low' });
    }

    const reloaded = await new PipenzoAuditStore(path).list();
    expect(reloaded.map((entry) => (entry.kind === 'review_gate_result' ? entry.outcome : undefined))).toEqual([
      ...outcomes,
    ]);
  });

  it('scopes a mixed log to one ticket across both new entry kinds and the pre-existing one', async () => {
    const path = await auditPath();
    const store = new PipenzoAuditStore(path);
    const ticketId = randomUUID();

    await store.append(divergenceEntry({ ticketId }));
    await store.append(publishEntry({ ticketId }));
    await store.append(reviewGateEntry({ ticketId }));
    await store.append(divergenceEntry());

    const scoped = await store.list({ ticketId });
    expect(scoped.map((entry) => entry.kind)).toEqual([
      'ticket_divergence',
      'publish_result',
      'review_gate_result',
    ]);
  });
});
