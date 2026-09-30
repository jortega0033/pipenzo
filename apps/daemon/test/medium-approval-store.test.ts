import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MediumApprovalStore } from '../src/medium-approval-store.js';

/** Same real-git-repo harness `undo-snapshot.test.ts` uses -- this store wraps `captureUndoSnapshot`
 * directly, so its own tests need the same real `HEAD` to compare against. */
const GIT_HEAVY_TIMEOUT_MS = 30_000;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })),
  );
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pipenzo-medium-approval-store-'));
  temporaryDirectories.push(dir);
  return dir;
}

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, windowsHide: true });
}

function initRepo(): string {
  const root = tempDir();
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.email', 'test@example.com']);
  git(root, ['config', 'user.name', 'Test']);
  git(root, ['commit', '--allow-empty', '-m', 'root']);
  return root;
}

function commitAll(root: string, message: string): void {
  git(root, ['add', '-A']);
  git(root, ['commit', '-m', message, '--allow-empty']);
}

const TICKET_A = '00000000-0000-4000-8000-00000000000a';
const TICKET_B = '00000000-0000-4000-8000-00000000000b';

describe('MediumApprovalStore.capture / decide', () => {
  it(
    'captures at riskGrade medium and returns a fresh id per call',
    async () => {
      const root = initRepo();
      await writeFile(join(root, 'a.txt'), 'before');
      commitAll(root, 'add a.txt');
      const store = new MediumApprovalStore();

      const id1 = await store.capture({ ticketId: TICKET_A, worktreeRoot: root, branch: 'main', touchedPaths: ['a.txt'] });
      const id2 = await store.capture({ ticketId: TICKET_A, worktreeRoot: root, branch: 'main', touchedPaths: ['a.txt'] });

      expect(id1).not.toBe(id2);
      expect(store.size).toBe(2);
    },
    GIT_HEAVY_TIMEOUT_MS,
  );

  it(
    'decide(allow) keeps the entry (for later status/undo); decide(reject) discards it',
    async () => {
      const root = initRepo();
      const store = new MediumApprovalStore();
      const allowedId = await store.capture({ ticketId: TICKET_A, worktreeRoot: root, branch: 'main', touchedPaths: [] });
      const rejectedId = await store.capture({ ticketId: TICKET_A, worktreeRoot: root, branch: 'main', touchedPaths: [] });

      const allowed = store.decide(TICKET_A, allowedId, 'allow', 'looks fine');
      const rejected = store.decide(TICKET_A, rejectedId, 'reject');

      expect(allowed).toMatchObject({ decision: 'allow', reason: 'looks fine' });
      expect(rejected).toMatchObject({ decision: 'reject' });
      expect(store.size).toBe(1); // only the allowed one is still held
    },
    GIT_HEAVY_TIMEOUT_MS,
  );

  it(
    'refuses a second decide() on the same snapshot (CLAUDE.md hard rule #4: a decision is not re-askable)',
    async () => {
      const root = initRepo();
      const store = new MediumApprovalStore();
      const id = await store.capture({ ticketId: TICKET_A, worktreeRoot: root, branch: 'main', touchedPaths: [] });

      expect(store.decide(TICKET_A, id, 'allow')).toBeDefined();
      expect(store.decide(TICKET_A, id, 'reject')).toBeUndefined();
      expect(store.decide(TICKET_A, id, 'allow')).toBeUndefined();
    },
    GIT_HEAVY_TIMEOUT_MS,
  );

  it(
    "refuses decide() for the right snapshot id under the wrong ticket (cross-ticket isolation)",
    async () => {
      const root = initRepo();
      const store = new MediumApprovalStore();
      const id = await store.capture({ ticketId: TICKET_A, worktreeRoot: root, branch: 'main', touchedPaths: [] });

      expect(store.decide(TICKET_B, id, 'allow')).toBeUndefined();
      // Still pending under its real ticket -- the wrong-ticket call did not consume it.
      expect(store.decide(TICKET_A, id, 'allow')).toBeDefined();
    },
    GIT_HEAVY_TIMEOUT_MS,
  );

  it('returns undefined for an unknown snapshot id', () => {
    const store = new MediumApprovalStore();
    expect(store.decide(TICKET_A, 'not-a-real-id', 'allow')).toBeUndefined();
  });
});

describe('MediumApprovalStore.status / undo', () => {
  it(
    'reports undo available right after an allow, and unavailable once another commit lands',
    async () => {
      const root = initRepo();
      await writeFile(join(root, 'a.txt'), 'before');
      commitAll(root, 'add a.txt');
      const store = new MediumApprovalStore();
      const id = await store.capture({ ticketId: TICKET_A, worktreeRoot: root, branch: 'main', touchedPaths: ['a.txt'] });
      store.decide(TICKET_A, id, 'allow');

      expect(await store.status(TICKET_A, id)).toEqual({ available: true, reason: undefined });

      commitAll(root, 'a second commit landed on the branch');
      expect(await store.status(TICKET_A, id)).toEqual({ available: false, reason: 'expired' });
    },
    GIT_HEAVY_TIMEOUT_MS,
  );

  it('status is undefined for a snapshot still pending a decision -- an un-decided action never ran', async () => {
    const root = initRepo();
    const store = new MediumApprovalStore();
    const id = await store.capture({ ticketId: TICKET_A, worktreeRoot: root, branch: 'main', touchedPaths: [] });
    expect(await store.status(TICKET_A, id)).toBeUndefined();
  });

  it('status is undefined under the wrong ticket, even for a real allowed snapshot', async () => {
    const root = initRepo();
    const store = new MediumApprovalStore();
    const id = await store.capture({ ticketId: TICKET_A, worktreeRoot: root, branch: 'main', touchedPaths: [] });
    store.decide(TICKET_A, id, 'allow');
    expect(await store.status(TICKET_B, id)).toBeUndefined();
  });

  it(
    'undo restores the touched file and discards the entry, so a second undo is refused',
    async () => {
      const root = initRepo();
      await writeFile(join(root, 'a.txt'), 'before');
      commitAll(root, 'add a.txt');
      const store = new MediumApprovalStore();
      const id = await store.capture({ ticketId: TICKET_A, worktreeRoot: root, branch: 'main', touchedPaths: ['a.txt'] });
      store.decide(TICKET_A, id, 'allow');
      await writeFile(join(root, 'a.txt'), 'the agent changed it');

      const outcome = await store.undo(TICKET_A, id);
      expect(outcome).toEqual({ restored: true });
      expect(store.size).toBe(0);
      expect(await store.undo(TICKET_A, id)).toBeUndefined();
    },
    GIT_HEAVY_TIMEOUT_MS,
  );

  it('undo is undefined for a snapshot that was rejected, not allowed', async () => {
    const root = initRepo();
    const store = new MediumApprovalStore();
    const id = await store.capture({ ticketId: TICKET_A, worktreeRoot: root, branch: 'main', touchedPaths: [] });
    store.decide(TICKET_A, id, 'reject');
    expect(await store.undo(TICKET_A, id)).toBeUndefined();
  });
});
