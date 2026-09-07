import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { PipenzoTicketRecordV1 } from '@agent-dock/shared';
import {
  FileTicketStore,
  TICKET_STORE_SCHEMA_VERSION,
  UnsupportedTicketStoreVersionError,
} from '../src/pipenzo-ticket-store.js';

const TICKET_ID = '00000000-0000-4000-8000-000000000001';
const SECOND_TICKET_ID = '00000000-0000-4000-8000-000000000002';
const CORRUPT_TICKET_ID = '00000000-0000-4000-8000-000000000003';
const temporaryDirectories: string[] = [];

function storeDirectory(): string {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'pipenzo-ticket-store-'));
  temporaryDirectories.push(temporaryDirectory);
  return join(temporaryDirectory, 'tickets-v1');
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { force: true, recursive: true });
  }
});

function makeTicket(overrides: Partial<PipenzoTicketRecordV1> = {}): PipenzoTicketRecordV1 {
  return {
    schemaVersion: 1,
    ticketId: TICKET_ID,
    repo: 'jortega0033/pipenzo',
    issueNumber: 187,
    lane: 'queued',
    phase: 'refine',
    labels: ['pipenzo:queued'],
    estimate: { lines: 0, files: 0, layered: false },
    taskType: 'chore',
    stack: { parentId: null, childIds: [], index: null },
    attempts: [],
    budget: { tokensUsed: 0, limit: 0 },
    risk: { score: 0, lastResetAt: '2026-01-01T00:00:00.000Z' },
    precommits: [],
    etags: {},
    ...overrides,
  };
}

describe('FileTicketStore', () => {
  it('creates a manifest on first use and persists a ticket record across restarts', () => {
    const directory = storeDirectory();
    const store = new FileTicketStore(directory);
    const ticket = makeTicket({ lane: 'working', phase: 'implement' });

    store.create(ticket);
    expect(store.get(TICKET_ID)).toEqual(ticket);
    expect(store.getRecoveryReport()).toMatchObject({
      manifestAction: 'created',
      loadedTicketCount: 0,
      quarantinedFiles: [],
    });
    expect(JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'))).toEqual({
      schemaVersion: TICKET_STORE_SCHEMA_VERSION,
    });

    const reopened = new FileTicketStore(directory);
    expect(reopened.get(TICKET_ID)).toEqual(ticket);
    expect(reopened.list()).toHaveLength(1);
    expect(reopened.getRecoveryReport()).toMatchObject({
      manifestAction: 'none',
      loadedTicketCount: 1,
      migratedRecordCount: 0,
      interruptedTicketIds: [],
      quarantinedFiles: [],
    });
    expect(readdirSync(join(directory, 'records'))).toEqual([`${TICKET_ID}.json`]);

    reopened.update(TICKET_ID, { ...ticket, lane: 'ready-for-review', phase: 'review' });
    expect(new FileTicketStore(directory).get(TICKET_ID)?.lane).toBe('ready-for-review');

    reopened.delete(TICKET_ID);
    expect(new FileTicketStore(directory).get(TICKET_ID)).toBeUndefined();
  });

  it('rejects update for a ticket that was never created', () => {
    const directory = storeDirectory();
    const store = new FileTicketStore(directory);
    const ticket = makeTicket();

    expect(() => store.update(TICKET_ID, ticket)).toThrow(`cannot update unknown ticket: ${TICKET_ID}`);
    expect(readdirSync(join(directory, 'records'))).toEqual([]);
  });

  it('refuses a manifest from a newer, forward-incompatible schema version rather than guessing at it', () => {
    const directory = storeDirectory();
    mkdirSync(directory, { recursive: true });
    const manifestPath = join(directory, 'manifest.json');
    writeFileSync(manifestPath, '{"schemaVersion":2}\n', 'utf8');

    expect(() => new FileTicketStore(directory)).toThrow(UnsupportedTicketStoreVersionError);
    // The untouched-on-refusal guarantee matters here: a newer daemon reading the same directory
    // later must find the manifest exactly as this older build left it, not a version this build
    // silently rebuilt or migrated because it did not recognise it.
    expect(readFileSync(manifestPath, 'utf8')).toBe('{"schemaVersion":2}\n');
  });

  it('refuses a ticket record from a newer schema version without touching any file', () => {
    const directory = storeDirectory();
    const recordsDirectory = join(directory, 'records');
    mkdirSync(recordsDirectory, { recursive: true });
    writeFileSync(join(directory, 'manifest.json'), '{"schemaVersion":1}\n', 'utf8');
    const futurePath = join(recordsDirectory, `${CORRUPT_TICKET_ID}.json`);
    const futureBytes = `${JSON.stringify({ ...makeTicket({ ticketId: CORRUPT_TICKET_ID }), schemaVersion: 2 })}\n`;
    writeFileSync(futurePath, futureBytes, 'utf8');

    expect(() => new FileTicketStore(directory)).toThrow(UnsupportedTicketStoreVersionError);
    expect(readFileSync(futurePath, 'utf8')).toBe(futureBytes);
    expect(readdirSync(join(directory, 'quarantine'))).toEqual([]);
  });

  it('quarantines a corrupt ticket record without losing a valid one', () => {
    const directory = storeDirectory();
    const store = new FileTicketStore(directory);
    store.create(makeTicket());
    const corruptPath = join(directory, 'records', `${CORRUPT_TICKET_ID}.json`);
    writeFileSync(corruptPath, '{"schemaVersion":1,"ticketId":', 'utf8');

    const reopened = new FileTicketStore(directory);
    const report = reopened.getRecoveryReport();
    expect(reopened.get(TICKET_ID)).toBeDefined();
    expect(report.loadedTicketCount).toBe(1);
    expect(report.quarantinedFiles).toHaveLength(1);
    expect(report.quarantinedFiles[0]?.originalPath).toBe(corruptPath);
    expect(readFileSync(report.quarantinedFiles[0]?.quarantinePath as string, 'utf8')).toBe(
      '{"schemaVersion":1,"ticketId":',
    );
    expect(existsSync(corruptPath)).toBe(false);
  });

  it('quarantines a temporary file left by an interrupted atomic write (record and manifest)', () => {
    const directory = storeDirectory();
    new FileTicketStore(directory);
    const recordTemporaryPath = join(directory, 'records', `.${TICKET_ID}.json.interrupted.tmp`);
    const manifestTemporaryPath = join(directory, '.manifest.json.interrupted.tmp');
    writeFileSync(recordTemporaryPath, '{"partial":', 'utf8');
    writeFileSync(manifestTemporaryPath, '{"manifestPartial":', 'utf8');

    const report = new FileTicketStore(directory).getRecoveryReport();
    expect(report.quarantinedFiles).toHaveLength(2);
    expect(report.quarantinedFiles.map(({ originalPath }) => originalPath).sort()).toEqual(
      [recordTemporaryPath, manifestTemporaryPath].sort(),
    );
    expect(
      report.quarantinedFiles.map(({ quarantinePath }) => readFileSync(quarantinePath, 'utf8')).sort(),
    ).toEqual(['{"manifestPartial":', '{"partial":'].sort());
  });

  it('rebuilds a corrupt manifest while preserving valid record files', () => {
    const directory = storeDirectory();
    const store = new FileTicketStore(directory);
    store.create(makeTicket());
    writeFileSync(join(directory, 'manifest.json'), '{"schemaVersion":', 'utf8');

    const reopened = new FileTicketStore(directory);
    expect(reopened.get(TICKET_ID)).toBeDefined();
    expect(reopened.getRecoveryReport()).toMatchObject({
      manifestAction: 'rebuilt',
      loadedTicketCount: 1,
    });
    expect(JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'))).toEqual({
      schemaVersion: TICKET_STORE_SCHEMA_VERSION,
    });
  });

  it('persists a ticket with a provisioned worktree and reloads it unchanged', () => {
    const directory = storeDirectory();
    const store = new FileTicketStore(directory);
    const ticket = makeTicket({
      lane: 'working',
      phase: 'implement',
      worktree: {
        id: SECOND_TICKET_ID,
        path: 'C:\\worktrees\\issue-187',
        branch: 'issue-187',
      },
    });

    store.create(ticket);
    expect(new FileTicketStore(directory).get(TICKET_ID)).toEqual(ticket);
  });

  it('treats deletion of an unknown ticket id as a no-op', () => {
    const store = new FileTicketStore(storeDirectory());
    expect(() => store.delete('never-existed')).not.toThrow();
    expect(() => store.delete(TICKET_ID)).not.toThrow();
  });

  it('creates private state directories and metadata files', () => {
    if (process.platform === 'win32') return;
    const directory = storeDirectory();
    const store = new FileTicketStore(directory);
    store.create(makeTicket());

    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(statSync(join(directory, 'records')).mode & 0o777).toBe(0o700);
    expect(statSync(join(directory, 'quarantine')).mode & 0o777).toBe(0o700);
    expect(statSync(join(directory, 'manifest.json')).mode & 0o777).toBe(0o600);
    expect(statSync(join(directory, 'records', `${TICKET_ID}.json`)).mode & 0o777).toBe(0o600);
  });
});
