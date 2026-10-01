import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PipenzoPhaseEventV1, PipenzoTicketRecordV1 } from '@agent-dock/shared';
import { ConnectedReposStore } from '../src/connected-repos-store.js';
import { ConditionalRequestCache } from '../src/github-conditional-cache.js';
import { FakeGitHubClient } from '../src/github-client-fake.js';
import {
  GitHubClientError,
  OctokitGitHubClient,
  type GitHubClient,
  type GitHubIssue,
} from '../src/github-client.js';
import { PipenzoPhaseEventBus } from '../src/pipenzo-phase-events.js';
import {
  PipenzoPhaseMachine,
  PipenzoPhaseMachineError,
  isIntakeEligible,
} from '../src/pipenzo-phase-machine.js';
import {
  DEFAULT_DISCOVERY_INTERVAL_MS,
  PipenzoReconciler,
  type PipenzoReconcilerScheduler,
} from '../src/pipenzo-reconciler.js';
import { materializeStack, type StackWorktreePort } from '../src/pipenzo-stack-materializer.js';
import { FileTicketStore } from '../src/pipenzo-ticket-store.js';

/**
 * Issue #511: every open issue of a connected repo is admitted into the board as `pipenzo:queued`.
 *
 * Real stores on disk, a real phase machine, and a real reconciler loop on a fake clock -- the only
 * thing faked is GitHub, and in the conditional-request suite not even that: there the real
 * `OctokitGitHubClient` and `ConditionalRequestCache` run over a stub transport that answers `304`
 * the way GitHub does, so "a quiet tick writes nothing and pays nothing" is asserted on the real code.
 */

const REPO = 'jortega0033/pipenzo';
const REF = { owner: 'jortega0033', repo: 'pipenzo' };

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { force: true, recursive: true });
  }
});

/** Same fake clock as `pipenzo-reconciler.test.ts`: timers fire only when the test advances it. */
class FakeScheduler implements PipenzoReconcilerScheduler {
  current = Date.now();
  readonly timers = new Map<number, { at: number; callback: () => void }>();
  #nextId = 1;

  now(): number {
    return this.current;
  }

  set(delayMs: number, callback: () => void): number {
    const id = this.#nextId++;
    this.timers.set(id, { at: this.current + delayMs, callback });
    return id;
  }

  clear(timer: unknown): void {
    this.timers.delete(timer as number);
  }

  advance(delayMs: number): void {
    this.current += delayMs;
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= this.current)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) return;
      this.timers.delete(due[0]);
      due[1].callback();
    }
  }
}

function tempDir(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(root);
  return root;
}

function makeTicket(overrides: Partial<PipenzoTicketRecordV1> = {}): PipenzoTicketRecordV1 {
  return {
    schemaVersion: 1,
    ticketId: randomUUID(),
    repo: REPO,
    issueNumber: 1,
    title: 'issue 1',
    lane: 'working',
    phase: 'implement',
    labels: ['pipenzo:working'],
    estimate: { lines: 40, files: 3, layered: false },
    taskType: 'feature',
    stack: { parentId: null, childIds: [], index: null },
    attempts: [],
    budget: { tokensUsed: 0, limit: 0 },
    risk: { score: 0, lastResetAt: '2026-01-01T00:00:00.000Z' },
    precommits: [],
    etags: {},
    ...overrides,
  };
}

function makeIssue(
  issueNumber: number,
  labels: readonly string[],
  overrides: Partial<GitHubIssue> = {},
): GitHubIssue {
  return {
    owner: REF.owner,
    repo: REF.repo,
    number: issueNumber,
    title: `issue ${issueNumber}`,
    body: '',
    state: 'open',
    labels: [...labels],
    assignees: [],
    htmlUrl: `https://github.com/${REPO}/issues/${issueNumber}`,
    updatedAt: '2026-01-01T00:00:00.000Z',
    etag: undefined,
    ...overrides,
  };
}

async function waitFor(assertion: () => void): Promise<void> {
  await vi.waitFor(assertion, { timeout: 2_000, interval: 5 });
}

interface HarnessOptions {
  tickets?: PipenzoTicketRecordV1[];
  github?: GitHubClient;
  intake?: boolean;
  pollIntervalMs?: number;
  maxAdmissionsPerMinute?: number;
  maxAdmissionsPerHour?: number;
}

function harness(options: HarnessOptions = {}) {
  const repos = new ConnectedReposStore(join(tempDir('pipenzo-intake-repos-'), 'connected-repos-v1.json'));
  const tickets = new FileTicketStore(tempDir('pipenzo-intake-tickets-'));
  for (const ticket of options.tickets ?? []) tickets.create(ticket);
  const github = options.github ?? new FakeGitHubClient();
  const events = new PipenzoPhaseEventBus();
  const machine = new PipenzoPhaseMachine({ tickets, github: () => github, events });
  const scheduler = new FakeScheduler();
  const reconciler = new PipenzoReconciler({
    repos,
    tickets,
    machine,
    ...(options.intake === false ? {} : { intake: machine }),
    github: () => github,
    scheduler,
    random: () => 0,
    pollIntervalMs: options.pollIntervalMs ?? 1_000,
    maxAdmissionsPerMinute: options.maxAdmissionsPerMinute,
    maxAdmissionsPerHour: options.maxAdmissionsPerHour,
  });
  return { repos, tickets, github, machine, events, scheduler, reconciler };
}

const callsTo = (github: FakeGitHubClient, method: string) =>
  github.calls.filter((call) => call.method === method);

describe('PipenzoReconciler intake (issue #511)', () => {
  it('leaves an issue the store already tracks exactly as it is', async () => {
    // Title matches the issue's, so the per-ticket read has nothing at all to rewrite.
    const tracked = makeTicket({ issueNumber: 11, title: 'issue 11' });
    const github = new FakeGitHubClient().seedIssue(makeIssue(11, ['pipenzo:working']));
    const { repos, tickets, reconciler, scheduler } = harness({ tickets: [tracked], github });
    await repos.replace([REPO]);

    reconciler.start();
    scheduler.advance(0);
    await waitFor(() => expect(reconciler.health().state).toBe('healthy'));
    await reconciler.stop();

    expect(callsTo(github, 'listOpenIssues')).toHaveLength(1);
    expect(callsTo(github, 'setIssueLabels')).toHaveLength(0);
    expect(tickets.list()).toEqual([tracked]);
    expect((await github.getIssue(REF, 11)).labels).toEqual(['pipenzo:working']);
  });

  it('admits every untracked open issue as pipenzo:queued, preserving foreign labels', async () => {
    const github = new FakeGitHubClient()
      .seedIssue(makeIssue(20, ['bug', 'good first issue']))
      .seedIssue(makeIssue(21, []))
      .seedIssue(makeIssue(22, [], { state: 'closed' }));
    const { repos, tickets, events, reconciler, scheduler } = harness({ github });
    const announced: PipenzoPhaseEventV1[] = [];
    events.subscribe(0, (event) => announced.push(event));
    await repos.replace([REPO]);

    reconciler.start();
    scheduler.advance(0);
    await waitFor(() => expect(tickets.list()).toHaveLength(2));
    await waitFor(() => expect(reconciler.health().state).toBe('healthy'));
    await reconciler.stop();

    const byIssue = new Map(tickets.list().map((ticket) => [ticket.issueNumber, ticket]));
    expect([...byIssue.keys()].sort()).toEqual([20, 21]);
    for (const ticket of byIssue.values()) {
      expect(ticket).toMatchObject({
        repo: REPO,
        lane: 'queued',
        phase: 'refine',
        labels: ['pipenzo:queued', 'pipenzo:schema-v1'],
        title: `issue ${ticket.issueNumber}`,
        stack: { parentId: null, childIds: [], index: null },
        attempts: [],
      });
    }
    // The authoritative side: the labels really are on GitHub, beside the human's own.
    expect((await github.getIssue(REF, 20)).labels).toEqual([
      'bug',
      'good first issue',
      'pipenzo:queued',
      'pipenzo:schema-v1',
    ]);
    // A closed issue is never intake's business.
    expect((await github.getIssue(REF, 22)).labels).toEqual([]);
    expect(announced.map((event) => [event.fromLane, event.toLane])).toEqual([
      ['queued', 'queued'],
      ['queued', 'queued'],
    ]);
  });

  it('never touches an issue that already carries a different pipenzo label', async () => {
    const github = new FakeGitHubClient()
      .seedIssue(makeIssue(30, ['pipenzo:working']))
      .seedIssue(makeIssue(31, ['pipenzo:needs-human', 'pipenzo:schema-v1']))
      .seedIssue(makeIssue(32, ['pipenzo:ci-failed']))
      .seedIssue(makeIssue(33, ['Pipenzo:Ready-For-Review']))
      .seedIssue(makeIssue(34, ['pipenzo:schema-v2']))
      .seedIssue(makeIssue(35, ['pipenzo:something-newer']))
      .seedIssue(makeIssue(36, ['enhancement']));
    const { repos, tickets, reconciler, scheduler } = harness({ github });
    await repos.replace([REPO]);

    reconciler.start();
    scheduler.advance(0);
    await waitFor(() => expect(tickets.list()).toHaveLength(1));
    await reconciler.stop();

    // Only the issue with no pipenzo state at all was admitted, and only it was written to.
    expect(tickets.list().map((ticket) => ticket.issueNumber)).toEqual([36]);
    expect(callsTo(github, 'setIssueLabels').map((call) => call.key)).toEqual([
      'jortega0033/pipenzo#36:pipenzo:queued,pipenzo:schema-v1',
    ]);
    expect((await github.getIssue(REF, 31)).labels).toEqual([
      'pipenzo:needs-human',
      'pipenzo:schema-v1',
    ]);
  });

  it('re-adopts an issue left labelled queued by a crash before its record was written', async () => {
    const github = new FakeGitHubClient().seedIssue(
      makeIssue(40, ['pipenzo:queued', 'pipenzo:schema-v1']),
    );
    const { repos, tickets, reconciler, scheduler } = harness({ github });
    await repos.replace([REPO]);

    reconciler.start();
    scheduler.advance(0);
    await waitFor(() => expect(tickets.list()).toHaveLength(1));
    await reconciler.stop();

    expect(tickets.list()[0]).toMatchObject({ issueNumber: 40, lane: 'queued' });
  });

  it('does not re-list a repo inside the discovery interval, and never writes twice', async () => {
    const github = new FakeGitHubClient().seedIssue(makeIssue(50, []));
    const { repos, tickets, reconciler, scheduler } = harness({ github, pollIntervalMs: 1_000 });
    await repos.replace([REPO]);

    reconciler.start();
    scheduler.advance(0);
    await waitFor(() => expect(tickets.list()).toHaveLength(1));
    await waitFor(() => expect(reconciler.health().state).toBe('healthy'));

    // A second tick well inside the interval: the admitted ticket is re-read, the repo is not re-listed.
    scheduler.advance(1_000);
    await waitFor(() => expect(callsTo(github, 'getIssue')).toHaveLength(1));
    expect(callsTo(github, 'listOpenIssues')).toHaveLength(1);

    // Past the interval the repo is listed again -- and finds nothing new to write.
    scheduler.advance(DEFAULT_DISCOVERY_INTERVAL_MS);
    await waitFor(() => expect(callsTo(github, 'listOpenIssues')).toHaveLength(2));
    await reconciler.stop();

    expect(callsTo(github, 'setIssueLabels')).toHaveLength(1);
    expect(tickets.list()).toHaveLength(1);
  });

  it('lists a newly connected repo on the very next tick', async () => {
    const otherRepo = 'jortega0033/other';
    const github = new FakeGitHubClient().seedIssue({
      ...makeIssue(60, []),
      owner: 'jortega0033',
      repo: 'other',
    });
    const { repos, tickets, reconciler, scheduler } = harness({ github, pollIntervalMs: 1_000 });
    await repos.replace([REPO]);

    reconciler.start();
    scheduler.advance(0);
    await waitFor(() => expect(callsTo(github, 'listOpenIssues')).toHaveLength(1));
    await waitFor(() => expect(reconciler.health().state).toBe('healthy'));

    await repos.replace([REPO, otherRepo]);
    scheduler.advance(1_000);
    await waitFor(() => expect(tickets.list()).toHaveLength(1));
    await reconciler.stop();

    // Only the new repo was listed on the second tick; the first was still inside its interval.
    expect(callsTo(github, 'listOpenIssues').map((call) => call.key)).toEqual([
      REPO,
      otherRepo,
    ]);
    expect(tickets.list()[0]).toMatchObject({ repo: otherRepo, issueNumber: 60 });
  });

  it('limits admissions per minute by wall clock and drains the rest from memory, not by re-listing', async () => {
    const github = new FakeGitHubClient()
      .seedIssue(makeIssue(71, []))
      .seedIssue(makeIssue(72, []))
      .seedIssue(makeIssue(73, []));
    const { repos, tickets, reconciler, scheduler } = harness({
      github,
      pollIntervalMs: 1_000,
      maxAdmissionsPerMinute: 2,
    });
    await repos.replace([REPO]);

    reconciler.start();
    scheduler.advance(0);
    await waitFor(() => expect(reconciler.health().state).toBe('healthy'));
    expect(tickets.list()).toHaveLength(2);

    // More ticks inside the same minute -- the way a burst of "Poll now" clicks would arrive --
    // admit nothing more: the limit is wall-clock, not per tick.
    scheduler.advance(1_000);
    await waitFor(() => expect(callsTo(github, 'getIssue').length).toBeGreaterThanOrEqual(2));
    scheduler.advance(1_000);
    await waitFor(() => expect(callsTo(github, 'getIssue').length).toBeGreaterThanOrEqual(4));
    expect(tickets.list()).toHaveLength(2);

    // A minute on, the remembered backlog drains -- without listing the repo a second time.
    scheduler.advance(60_000);
    await waitFor(() => expect(tickets.list()).toHaveLength(3));
    await reconciler.stop();

    expect(callsTo(github, 'setIssueLabels')).toHaveLength(3);
    expect(callsTo(github, 'listOpenIssues')).toHaveLength(1);
  });

  it('holds the hourly limit across listings, and lists nothing while it is spent', async () => {
    const github = new FakeGitHubClient()
      .seedIssue(makeIssue(76, []))
      .seedIssue(makeIssue(77, []))
      .seedIssue(makeIssue(78, []));
    const { repos, tickets, reconciler, scheduler } = harness({
      github,
      pollIntervalMs: 1_000,
      maxAdmissionsPerHour: 2,
    });
    await repos.replace([REPO]);

    reconciler.start();
    scheduler.advance(0);
    await waitFor(() => expect(tickets.list()).toHaveLength(2));
    await waitFor(() => expect(reconciler.health().state).toBe('healthy'));

    // Past the discovery interval the stale backlog is dropped, but with the hour's allowance spent
    // the repo is not even re-listed: a listing could not be drained before it went stale.
    scheduler.advance(DEFAULT_DISCOVERY_INTERVAL_MS + 1_000);
    await waitFor(() => expect(callsTo(github, 'getIssue').length).toBeGreaterThanOrEqual(2));
    expect(callsTo(github, 'listOpenIssues')).toHaveLength(1);
    expect(tickets.list()).toHaveLength(2);

    scheduler.advance(3_600_000);
    await waitFor(() => expect(tickets.list()).toHaveLength(3));
    await reconciler.stop();
    expect(callsTo(github, 'listOpenIssues')).toHaveLength(2);
  });

  it('pauses intake entirely while quota is degraded', async () => {
    const github = new FakeGitHubClient().seedIssue(makeIssue(80, []));
    github.seedRateLimitHeaders({
      'x-ratelimit-resource': 'core',
      'x-ratelimit-limit': '100',
      'x-ratelimit-remaining': '10',
      'x-ratelimit-reset': String(Math.floor((Date.now() + 3_600_000) / 1_000)),
    });
    const { repos, tickets, reconciler, scheduler } = harness({ github });
    await repos.replace([REPO]);

    reconciler.start();
    scheduler.advance(0);
    await waitFor(() => expect(reconciler.health().state).toBe('unknown'));
    await reconciler.stop();

    expect(callsTo(github, 'listOpenIssues')).toHaveLength(0);
    expect(tickets.list()).toHaveLength(0);
  });

  it('reports a credential GitHub rejected on the listing, writing nothing', async () => {
    const github = new FakeGitHubClient().seedIssue(makeIssue(90, []));
    github.failNext('listOpenIssues', new GitHubClientError('unauthorized', 'bad token'));
    const { repos, tickets, reconciler, scheduler } = harness({ github });
    await repos.replace([REPO]);

    reconciler.start();
    scheduler.advance(0);
    await waitFor(() => expect(reconciler.health().state).toBe('credential_rejected'));
    await reconciler.stop();

    expect(callsTo(github, 'setIssueLabels')).toHaveLength(0);
    expect(tickets.list()).toHaveLength(0);
  });

  it('enters the failure ladder when the listing cannot reach GitHub at all', async () => {
    const github = new FakeGitHubClient().seedIssue(makeIssue(91, []));
    github.failNext('listOpenIssues', new GitHubClientError('network', 'offline'));
    const { repos, reconciler, scheduler } = harness({ github });
    await repos.replace([REPO]);

    reconciler.start();
    scheduler.advance(0);
    await waitFor(() => expect(reconciler.health().state).toBe('retrying'));
    await reconciler.stop();
  });

  it('never lists a repo when intake is not wired', async () => {
    const github = new FakeGitHubClient().seedIssue(makeIssue(95, []));
    const { repos, tickets, reconciler, scheduler } = harness({ github, intake: false });
    await repos.replace([REPO]);

    reconciler.start();
    scheduler.advance(0);
    await waitFor(() => expect(reconciler.health().state).toBe('unknown'));
    await reconciler.stop();

    expect(callsTo(github, 'listOpenIssues')).toHaveLength(0);
    expect(tickets.list()).toHaveLength(0);
  });
});

describe('PipenzoPhaseMachine.admit (issue #511)', () => {
  function machineWith(github: FakeGitHubClient, existing: PipenzoTicketRecordV1[] = []) {
    const tickets = new FileTicketStore(tempDir('pipenzo-admit-tickets-'));
    for (const ticket of existing) tickets.create(ticket);
    return { tickets, machine: new PipenzoPhaseMachine({ tickets, github: () => github }) };
  }

  it('returns the existing record and writes nothing for an issue already tracked', async () => {
    const github = new FakeGitHubClient().seedIssue(makeIssue(1, ['pipenzo:working']));
    const existing = makeTicket({ issueNumber: 1, repo: 'JOrtega0033/Pipenzo' });
    const { machine } = machineWith(github, [existing]);

    const result = await machine.admit(REPO, { number: 1, title: 'issue 1', labels: [] });

    expect(result).toEqual({ ticket: existing, admitted: false });
    expect(github.calls).toHaveLength(0);
  });

  it('refuses an issue carrying another pipenzo lane, before any write', async () => {
    const github = new FakeGitHubClient().seedIssue(makeIssue(2, ['pipenzo:working']));
    const { machine, tickets } = machineWith(github);

    const error = await machine
      .admit(REPO, { number: 2, title: 'issue 2', labels: ['pipenzo:working'] })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PipenzoPhaseMachineError);
    expect((error as PipenzoPhaseMachineError).code).toBe('illegal_transition');
    expect(github.calls).toHaveLength(0);
    expect(tickets.list()).toHaveLength(0);
  });

  /**
   * The security review's M1: the caller decided from a listing that said "no pipenzo labels", but
   * by the time of the write somebody had moved the issue into a lane. Refused, not overwritten.
   */
  it('refuses, rather than overwrites, a lane set on GitHub after the listing it decided from', async () => {
    const github = new FakeGitHubClient().seedIssue(
      makeIssue(4, ['bug', 'pipenzo:working', 'pipenzo:schema-v1']),
    );
    const { machine, tickets } = machineWith(github);

    const error = await machine
      .admit(REPO, { number: 4, title: 'issue 4', labels: ['bug'] })
      .catch((caught: unknown) => caught);

    expect((error as PipenzoPhaseMachineError).code).toBe('illegal_transition');
    expect((await github.getIssue(REF, 4)).labels).toEqual([
      'bug',
      'pipenzo:working',
      'pipenzo:schema-v1',
    ]);
    expect(tickets.list()).toHaveLength(0);
  });

  it('also refuses a newer schema marker that appeared after the listing', async () => {
    const github = new FakeGitHubClient().seedIssue(makeIssue(6, ['pipenzo:schema-v2']));
    const { machine } = machineWith(github);
    const error = await machine
      .admit(REPO, { number: 6, title: 'issue 6', labels: [] })
      .catch((caught: unknown) => caught);
    expect((error as PipenzoPhaseMachineError).code).toBe('illegal_transition');
    expect((await github.getIssue(REF, 6)).labels).toEqual(['pipenzo:schema-v2']);
  });

  /**
   * The security review's M2: a record for the issue created while the label write was in flight
   * (the stack materializer's window) must win, never be joined by a second record.
   */
  it('yields to a record created while its own label write was in flight', async () => {
    const github = new FakeGitHubClient().seedIssue(makeIssue(7, []));
    const { machine, tickets } = machineWith(github);
    const racer = makeTicket({ issueNumber: 7, lane: 'queued', labels: ['pipenzo:queued'] });
    const write = github.setIssueLabels.bind(github);
    github.setIssueLabels = async (...args) => {
      const result = await write(...args);
      tickets.create(racer);
      return result;
    };

    const result = await machine.admit(REPO, { number: 7, title: 'issue 7', labels: [] });

    expect(result).toEqual({ ticket: racer, admitted: false });
    expect(tickets.list()).toEqual([racer]);
  });

  it('writes no record when the label write fails, so GitHub and the store never disagree', async () => {
    const github = new FakeGitHubClient().seedIssue(makeIssue(3, []));
    github.failNext('setIssueLabels', new GitHubClientError('forbidden', 'no push access'));
    const { machine, tickets } = machineWith(github);

    const error = await machine
      .admit(REPO, { number: 3, title: 'issue 3', labels: [] })
      .catch((caught: unknown) => caught);

    expect((error as PipenzoPhaseMachineError).code).toBe('github_forbidden');
    expect(tickets.list()).toHaveLength(0);
  });

  it('isIntakeEligible accepts only issues whose pipenzo labels are queued and the v1 marker', () => {
    expect(isIntakeEligible([])).toBe(true);
    expect(isIntakeEligible(['bug', 'help wanted'])).toBe(true);
    expect(isIntakeEligible(['pipenzo:queued', 'pipenzo:schema-v1', 'bug'])).toBe(true);
    expect(isIntakeEligible(['pipenzo:working'])).toBe(false);
    expect(isIntakeEligible(['pipenzo:interrupted'])).toBe(false);
    expect(isIntakeEligible(['PIPENZO:queued'])).toBe(false);
    expect(isIntakeEligible(['pipenzo:schema-v2'])).toBe(false);
  });
});

/**
 * The security review's M2, materializer side: `materializeStack` labels each child issue
 * `pipenzo:queued` before it can write the child's record (a worktree and a branch come first), so
 * intake can admit the child in between. The materializer must take that record over, not add a
 * second one beside it.
 */
describe('materializeStack alongside intake (issue #511)', () => {
  it('takes over a child record intake admitted mid-materialization instead of duplicating it', async () => {
    const github = new FakeGitHubClient();
    const tickets = new FileTicketStore(tempDir('pipenzo-intake-stack-tickets-'));
    const parent = makeTicket({
      issueNumber: 100,
      lane: 'needs-human',
      labels: ['pipenzo:awaiting-stack-approval', 'pipenzo:schema-v1'],
    });
    tickets.create(parent);
    const machine = new PipenzoPhaseMachine({ tickets, github: () => github });
    const worktreePath = tempDir('pipenzo-intake-stack-worktree-');
    const WORKTREE_ID = randomUUID();
    let admittedId: string | undefined;
    const worktrees: StackWorktreePort = {
      create: async () => {
        // A reconciler tick landing in the materializer's window: the child issue exists and is
        // labelled queued, but no record tracks it yet.
        const { issues } = await github.listOpenIssues(REF);
        const child = issues.find((issue) => issue.number !== parent.issueNumber);
        if (!child) throw new Error('expected the child issue to be listed');
        const result = await machine.admit(REPO, child);
        expect(result.admitted).toBe(true);
        admittedId = result.ticket.ticketId;
        return { id: WORKTREE_ID };
      },
      ownedLocation: () => ({ path: worktreePath }),
    };

    const children = await materializeStack({
      parentTicket: parent,
      repositoryPath: worktreePath,
      orderedParts: [{ summary: 'Extract the shared schema', changedLines: 40, filesTouched: 2 }],
      github,
      repoRef: REF,
      worktrees,
      tickets,
      runGit: async () => ({ stdout: '', stderr: '', code: 0 }),
    });

    const childRecords = tickets.list().filter((ticket) => ticket.ticketId !== parent.ticketId);
    expect(childRecords).toHaveLength(1);
    expect(children.map((child) => child.ticketId)).toEqual([admittedId]);
    expect(childRecords[0]).toMatchObject({
      ticketId: admittedId,
      lane: 'queued',
      stack: { parentId: parent.ticketId, index: 0 },
      worktree: { id: WORKTREE_ID },
    });
  });
});

/**
 * The quota half of #511, on the real client: a second pass with nothing changed on GitHub must be
 * answered by `304` and write nothing. The stub transport models GitHub's own ETag behaviour -- a
 * label write changes the issue, so the page it sits on gets a new ETag -- rather than replaying
 * canned answers, so the assertions hold only if the real client and cache behave correctly.
 */
describe('intake over the real client and conditional cache (issue #511)', () => {
  interface StubIssue {
    title: string;
    labels: string[];
    pullRequest?: boolean;
  }

  function githubModel(seed: Record<number, StubIssue>) {
    const issues = new Map(Object.entries(seed).map(([number, issue]) => [Number(number), issue]));
    let version = 1;
    const listEtag = () => `W/"open-issues-v${version}"`;
    const writes: number[] = [];
    const listRequests: Array<string | undefined> = [];
    const raw = (number: number, issue: StubIssue) => ({
      number,
      title: issue.title,
      state: 'open',
      body: '',
      labels: issue.labels.map((name) => ({ name })),
      assignees: [],
      html_url: `https://github.com/${REPO}/issues/${number}`,
      updated_at: `2026-01-01T00:00:0${version}Z`,
      ...(issue.pullRequest ? { pull_request: { url: 'https://api.github.com/x' } } : {}),
    });
    const notModified = (): Error =>
      Object.assign(new Error('Not modified'), { status: 304, response: { headers: {} } });

    const octokit = {
      request: async (route: string, params: Record<string, unknown>) => {
        const headers = (params.headers ?? {}) as Record<string, string>;
        if (route === 'GET /repos/{owner}/{repo}/issues') {
          listRequests.push(headers['if-none-match']);
          if (headers['if-none-match'] === listEtag()) throw notModified();
          const data = [...issues.entries()]
            .sort(([a], [b]) => b - a)
            .map(([number, issue]) => raw(number, issue));
          return { headers: { etag: listEtag() }, data };
        }
        if (route === 'GET /repos/{owner}/{repo}/issues/{issue_number}') {
          const number = Number(params.issue_number);
          const issue = issues.get(number);
          if (!issue) throw Object.assign(new Error('Not found'), { status: 404 });
          return { headers: {}, data: raw(number, issue) };
        }
        if (route === 'PUT /repos/{owner}/{repo}/issues/{issue_number}/labels') {
          const number = Number(params.issue_number);
          const issue = issues.get(number);
          if (!issue) throw Object.assign(new Error('Not found'), { status: 404 });
          issue.labels = [...(params.labels as string[])];
          writes.push(number);
          version += 1; // The issue changed, so the page listing it has a new ETag.
          return { headers: {}, data: issue.labels.map((name) => ({ name })) };
        }
        throw new Error(`unexpected request ${route}`);
      },
      paginate: async (route: string, params: Record<string, unknown>) => {
        if (route === 'GET /repos/{owner}/{repo}/issues/{issue_number}/labels') {
          return (issues.get(Number(params.issue_number))?.labels ?? []).map((name) => ({ name }));
        }
        throw new Error(`unexpected paginate ${route}`);
      },
    };
    return { octokit: octokit as never, issues, writes, listRequests, listEtag };
  }

  it('admits once, then a pass with nothing changed on GitHub is a 304 that writes nothing', async () => {
    const model = githubModel({
      12: { title: 'Untracked', labels: ['bug'] },
      11: { title: 'A pull request', labels: [], pullRequest: true },
      10: { title: 'Already in a lane', labels: ['pipenzo:needs-human'] },
    });
    const cache = new ConditionalRequestCache();
    const client = OctokitGitHubClient.withOctokit(model.octokit, { cache });
    const { repos, tickets, reconciler, scheduler } = harness({ github: client, pollIntervalMs: 1_000 });
    await repos.replace([REPO]);

    reconciler.start();
    scheduler.advance(0);
    await waitFor(() => expect(tickets.list()).toHaveLength(1));
    await waitFor(() => expect(reconciler.health().state).toBe('healthy'));

    // Only the real untracked issue was written: never the PR, never the one already in a lane.
    expect(model.writes).toEqual([12]);
    expect(model.issues.get(12)?.labels).toEqual(['bug', 'pipenzo:queued', 'pipenzo:schema-v1']);
    expect(model.issues.get(11)?.labels).toEqual([]);
    expect(model.issues.get(10)?.labels).toEqual(['pipenzo:needs-human']);
    expect(tickets.list()[0]).toMatchObject({ issueNumber: 12, lane: 'queued', title: 'Untracked' });

    // Second pass: our own write changed the page, so GitHub answers 200 -- and there is nothing
    // left to admit.
    scheduler.advance(DEFAULT_DISCOVERY_INTERVAL_MS);
    await waitFor(() => expect(model.listRequests).toHaveLength(2));
    await waitFor(() => expect(reconciler.health().state).toBe('healthy'));
    const notModifiedBefore = cache.stats.notModified;

    // Third pass, nothing changed on GitHub since: a conditional request answered 304.
    scheduler.advance(DEFAULT_DISCOVERY_INTERVAL_MS);
    await waitFor(() => expect(model.listRequests).toHaveLength(3));
    await waitFor(() => expect(cache.stats.notModified).toBeGreaterThan(notModifiedBefore));
    await reconciler.stop();

    expect(model.listRequests[0]).toBeUndefined();
    expect(model.listRequests[2]).toBe(model.listEtag());
    expect(model.writes).toEqual([12]);
    expect(tickets.list()).toHaveLength(1);
  });
});
