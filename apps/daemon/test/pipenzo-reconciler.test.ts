import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pipenzoGitHubHealthV1Schema, type PipenzoTicketRecordV1 } from '@agent-dock/shared';
import { ConnectedReposStore } from '../src/connected-repos-store.js';
import { FileTicketStore } from '../src/pipenzo-ticket-store.js';
import { PipenzoPhaseMachine } from '../src/pipenzo-phase-machine.js';
import { FakeGitHubClient } from '../src/github-client-fake.js';
import { GitHubClientError, type GitHubIssue } from '../src/github-client.js';
import {
  DEFAULT_MAX_POLL_ATTEMPTS,
  DEFAULT_POLL_INTERVAL_MS,
  DEGRADED_INTERVAL_MULTIPLIER,
  PipenzoReconciler,
  type PipenzoReconcilerScheduler,
} from '../src/pipenzo-reconciler.js';

const REPO = 'jortega0033/pipenzo';
const REF = { owner: 'jortega0033', repo: 'pipenzo' };

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { force: true, recursive: true });
  }
  vi.restoreAllMocks();
});

/**
 * Fires timers on a fake clock the test drives explicitly, matching `FakeScheduler` in
 * `interaction-state.test.ts`. Started at real `Date.now()` so a seeded rate-limit reading's real
 * `resetAt` (an hour in real wall-clock time) reads as unexpired without the test having to thread
 * a second clock through `FakeGitHubClient.seedRateLimitHeaders`.
 */
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

  /** Advances the clock and fires every timer now due, in schedule order. */
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

function repoStore(): ConnectedReposStore {
  const root = mkdtempSync(join(tmpdir(), 'pipenzo-reconciler-repos-'));
  temporaryDirectories.push(root);
  return new ConnectedReposStore(join(root, 'connected-repos-v1.json'));
}

function ticketStore(): FileTicketStore {
  const root = mkdtempSync(join(tmpdir(), 'pipenzo-reconciler-tickets-'));
  temporaryDirectories.push(root);
  return new FileTicketStore(root);
}

function makeTicket(overrides: Partial<PipenzoTicketRecordV1> = {}): PipenzoTicketRecordV1 {
  return {
    schemaVersion: 1,
    ticketId: randomUUID(),
    repo: REPO,
    issueNumber: 1,
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

function makeIssue(issueNumber: number, labels: readonly string[]): GitHubIssue {
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
  };
}

/** Polls a real assertion until it passes, for the fs-backed stores' genuinely async I/O. */
async function waitFor(assertion: () => void): Promise<void> {
  await vi.waitFor(assertion, { timeout: 2_000, interval: 5 });
}

interface HarnessOptions {
  tickets?: PipenzoTicketRecordV1[];
  repos?: readonly string[];
  github?: FakeGitHubClient;
  pollIntervalMs?: number;
  maxAttempts?: number;
  random?: () => number;
}

function harness(options: HarnessOptions = {}) {
  const repos = repoStore();
  const tickets = ticketStore();
  for (const ticket of options.tickets ?? []) tickets.create(ticket);
  const github = options.github ?? new FakeGitHubClient();
  const machine = new PipenzoPhaseMachine({ tickets, github: () => github });
  const scheduler = new FakeScheduler();
  const reconciler = new PipenzoReconciler({
    repos,
    tickets,
    machine,
    github: () => github,
    scheduler,
    random: options.random ?? (() => 0),
    pollIntervalMs: options.pollIntervalMs,
    maxAttempts: options.maxAttempts,
  });
  return { repos, tickets, github, machine, scheduler, reconciler };
}

describe('PipenzoReconciler', () => {
  it('treats an empty connected-repos list as a steady state, not an error', async () => {
    const { reconciler, scheduler } = harness();
    reconciler.start();
    scheduler.advance(0);
    await waitFor(() => expect(reconciler.health().state).toBe('unknown'));
    expect(reconciler.health()).not.toHaveProperty('error');
    await reconciler.stop();
  });

  it('defaults the ladder ceiling to DEFAULT_MAX_POLL_ATTEMPTS when not overridden', async () => {
    const ticket = makeTicket({ issueNumber: 11 });
    const github = new FakeGitHubClient().seedIssue(makeIssue(11, ['pipenzo:working']));
    const { repos, reconciler, scheduler } = harness({ tickets: [ticket], github });
    await repos.replace([REPO]);

    github.failNext('getIssue', new GitHubClientError('network', 'boom'));
    reconciler.start();
    scheduler.advance(0);

    await waitFor(() => expect(reconciler.health().state).toBe('retrying'));
    const health = reconciler.health();
    if (health.state !== 'retrying') throw new Error('expected retrying');
    expect(health.maxAttempts).toBe(DEFAULT_MAX_POLL_ATTEMPTS);

    await reconciler.stop();
  });

  it('polls every ticket of every connected repo cleanly in one tick', async () => {
    const otherRepo = 'jortega0033/other';
    const otherRef = { owner: 'jortega0033', repo: 'other' };
    const ticketA = makeTicket({ issueNumber: 11 });
    const ticketB = makeTicket({ repo: otherRepo, issueNumber: 22 });
    const github = new FakeGitHubClient()
      .seedIssue(makeIssue(11, ['pipenzo:working']))
      .seedIssue({ ...makeIssue(22, ['pipenzo:working']), ...otherRef });
    const { repos, reconciler, scheduler } = harness({ tickets: [ticketA, ticketB], github });
    await repos.replace([REPO, otherRepo]);

    reconciler.start();
    scheduler.advance(0);

    await waitFor(() => expect(reconciler.health().state).toBe('healthy'));
    const health = reconciler.health();
    expect(health.state).toBe('healthy');
    expect(pipenzoGitHubHealthV1Schema.safeParse(health).success).toBe(true);
    expect(github.calls.filter((call) => call.method === 'getIssue')).toHaveLength(2);

    await reconciler.stop();
  });

  it('ignores a ticket whose repo was never connected', async () => {
    const ticket = makeTicket({ repo: 'someone-else/unrelated', issueNumber: 1 });
    const github = new FakeGitHubClient();
    const { repos, reconciler, scheduler } = harness({ tickets: [ticket], github });
    await repos.replace([REPO]);

    reconciler.start();
    scheduler.advance(0);

    // Nothing belonging to a connected repo, so the tick has nothing to poll -- and must not be
    // reported as a clean poll it never made.
    await waitFor(() => expect(reconciler.health().state).toBe('unknown'));
    expect(github.calls).toHaveLength(0);
    await reconciler.stop();
  });

  it('a repeated poll of an unchanged issue stays healthy and reads it exactly once per tick', async () => {
    const ticket = makeTicket({ issueNumber: 11 });
    const github = new FakeGitHubClient().seedIssue(makeIssue(11, ['pipenzo:working']));
    const { repos, reconciler, scheduler } = harness({
      tickets: [ticket],
      github,
      pollIntervalMs: 1_000,
    });
    await repos.replace([REPO]);

    reconciler.start();
    scheduler.advance(0);
    await waitFor(() => expect(reconciler.health().state).toBe('healthy'));
    const first = reconciler.health();
    if (first.state !== 'healthy') throw new Error('expected healthy');

    // The label never changes between polls, which is exactly what a `304` looks like from the
    // reconciler's side: `machine.read()` resolves the same way, does no extra work, and the loop's
    // cadence is unaffected.
    expect(scheduler.timers.size).toBe(1);
    scheduler.advance(1_000);
    await waitFor(() =>
      expect(github.calls.filter((call) => call.method === 'getIssue')).toHaveLength(2),
    );
    const second = reconciler.health();
    if (second.state !== 'healthy') throw new Error('expected healthy');
    expect(second.lastCleanPollAt).toBeGreaterThan(first.lastCleanPollAt);

    await reconciler.stop();
  });

  it('raises the attempt count and backs off on a connection failure, then recovers', async () => {
    const ticket = makeTicket({ issueNumber: 11 });
    const github = new FakeGitHubClient().seedIssue(makeIssue(11, ['pipenzo:working']));
    const { repos, reconciler, scheduler } = harness({
      tickets: [ticket],
      github,
      pollIntervalMs: 1_000,
      maxAttempts: 3,
      random: () => 0,
    });
    await repos.replace([REPO]);

    github.failNext('getIssue', new GitHubClientError('network', 'boom'));
    reconciler.start();
    scheduler.advance(0);

    await waitFor(() => expect(reconciler.health().state).toBe('retrying'));
    const first = reconciler.health();
    if (first.state !== 'retrying') throw new Error('expected retrying');
    expect(first.attempt).toBe(1);
    expect(first.maxAttempts).toBe(3);
    expect(first.consecutiveFailures).toBe(1);
    expect(pipenzoGitHubHealthV1Schema.safeParse(first).success).toBe(true);
    // random() = 0 makes `#jitter` deterministic: exactly half of the un-jittered delay.
    expect(first.nextAttemptAt - scheduler.now()).toBe(500);

    // A second consecutive failure doubles the un-jittered ladder position (attempt 2 => 2x base).
    github.failNext('getIssue', new GitHubClientError('network', 'boom again'));
    scheduler.advance(500);
    await waitFor(() => {
      const health = reconciler.health();
      if (health.state !== 'retrying' || health.attempt !== 2) throw new Error('not yet attempt 2');
    });
    const second = reconciler.health();
    if (second.state !== 'retrying') throw new Error('expected retrying');
    expect(second.consecutiveFailures).toBe(2);
    expect(second.nextAttemptAt - scheduler.now()).toBe(1_000);

    // A third and final failure exhausts the 3-attempt ceiling: `unreachable`, not a fourth retry.
    github.failNext('getIssue', new GitHubClientError('network', 'boom a third time'));
    scheduler.advance(1_000);
    await waitFor(() => expect(reconciler.health().state).toBe('unreachable'));
    const third = reconciler.health();
    if (third.state !== 'unreachable') throw new Error('expected unreachable');
    expect(third.consecutiveFailures).toBe(3);
    expect(third.maxAttempts).toBe(3);
    expect(pipenzoGitHubHealthV1Schema.safeParse(third).success).toBe(true);

    // GitHub answers again: the run resets, the failure counters clear, and a clean poll publishes.
    scheduler.advance(third.nextAttemptAt !== undefined ? third.nextAttemptAt - scheduler.now() : 4_000);
    await waitFor(() => expect(reconciler.health().state).toBe('healthy'));
    const recovered = reconciler.health();
    if (recovered.state !== 'healthy') throw new Error('expected healthy');
    expect(recovered.lastCleanPollAt).toBe(scheduler.now());

    await reconciler.stop();
  });

  it('short-circuits a rejected credential without entering the backoff ladder', async () => {
    const ticket = makeTicket({ issueNumber: 11 });
    const github = new FakeGitHubClient().seedIssue(makeIssue(11, ['pipenzo:working']));
    const { repos, reconciler, scheduler } = harness({
      tickets: [ticket],
      github,
      pollIntervalMs: 1_000,
    });
    await repos.replace([REPO]);

    github.failNext('getIssue', new GitHubClientError('unauthorized', 'token revoked'));
    reconciler.start();
    scheduler.advance(0);

    await waitFor(() => expect(reconciler.health().state).toBe('credential_rejected'));
    const health = reconciler.health();
    expect(pipenzoGitHubHealthV1Schema.safeParse(health).success).toBe(true);
    // No ladder: the next poll is scheduled at the base cadence, not a widening backoff, because
    // only a human reconnecting fixes a rejected credential.
    expect([...scheduler.timers.values()][0]?.at).toBe(scheduler.now() + 500);

    await reconciler.stop();
  });

  it('jitters the retry delay rather than scheduling every failing repo at the same instant', async () => {
    const ticket = makeTicket({ issueNumber: 11 });
    const github = new FakeGitHubClient().seedIssue(makeIssue(11, ['pipenzo:working']));

    const lowJitter = harness({ tickets: [ticket], github, pollIntervalMs: 1_000, random: () => 0 });
    await lowJitter.repos.replace([REPO]);
    lowJitter.github.failNext('getIssue', new GitHubClientError('network', 'boom'));
    lowJitter.reconciler.start();
    lowJitter.scheduler.advance(0);
    await waitFor(() => expect(lowJitter.reconciler.health().state).toBe('retrying'));
    const lowDelay = [...lowJitter.scheduler.timers.values()][0]!.at - lowJitter.scheduler.now();
    await lowJitter.reconciler.stop();

    const highGithub = new FakeGitHubClient().seedIssue(makeIssue(11, ['pipenzo:working']));
    const highJitter = harness({
      tickets: [ticket],
      github: highGithub,
      pollIntervalMs: 1_000,
      random: () => 0.9,
    });
    await highJitter.repos.replace([REPO]);
    highJitter.github.failNext('getIssue', new GitHubClientError('network', 'boom'));
    highJitter.reconciler.start();
    highJitter.scheduler.advance(0);
    await waitFor(() => expect(highJitter.reconciler.health().state).toBe('retrying'));
    const highDelay = [...highJitter.scheduler.timers.values()][0]!.at - highJitter.scheduler.now();
    await highJitter.reconciler.stop();

    // Equal jitter: [delay/2, delay). Two different `random()` outputs against the same un-jittered
    // ladder position must land at two different instants, or every repo failing at once against
    // one upstream would retry in lock-step.
    expect(lowDelay).toBe(500);
    expect(highDelay).toBeGreaterThan(lowDelay);
    expect(highDelay).toBeLessThan(1_000);
  });

  it('widens the interval below ~15% remaining quota instead of failing', async () => {
    const ticket = makeTicket({ issueNumber: 11 });
    const github = new FakeGitHubClient().seedIssue(makeIssue(11, ['pipenzo:working']));
    github.seedRateLimitHeaders({
      'x-ratelimit-resource': 'core',
      'x-ratelimit-limit': '100',
      'x-ratelimit-remaining': '10', // 10% remaining, below DEGRADED_QUOTA_FRACTION (15%)
      'x-ratelimit-reset': String(Math.floor((Date.now() + 3_600_000) / 1_000)),
    });
    const { repos, reconciler, scheduler } = harness({
      tickets: [ticket],
      github,
      pollIntervalMs: 1_000,
    });
    await repos.replace([REPO]);

    reconciler.start();
    scheduler.advance(0);

    await waitFor(() => expect(reconciler.health().state).toBe('healthy'));
    const health = reconciler.health();
    expect(health.quota?.degraded).toBe(true);
    expect(health.quota?.remainingFraction).toBeCloseTo(0.1);
    // Widened, not failed: the tick still completed cleanly, and the next poll is scheduled further
    // out (DEGRADED_INTERVAL_MULTIPLIER x base) rather than the loop stopping or erroring.
    const nextAt = [...scheduler.timers.values()][0]!.at;
    expect(nextAt - scheduler.now()).toBe((1_000 * DEGRADED_INTERVAL_MULTIPLIER) / 2);

    await reconciler.stop();
  });

  it('does not stack a second tick while the first is still in flight', async () => {
    let readCalls = 0;
    let resolveRead: (() => void) | undefined;
    const machine = {
      read: async () => {
        readCalls += 1;
        await new Promise<void>((resolve) => {
          resolveRead = resolve;
        });
        return { changed: false } as never;
      },
    };
    const ticket = makeTicket({ issueNumber: 11 });
    const repos = repoStore();
    const tickets = ticketStore();
    tickets.create(ticket);
    await repos.replace([REPO]);
    const scheduler = new FakeScheduler();
    const reconciler = new PipenzoReconciler({
      repos,
      tickets,
      machine,
      scheduler,
      random: () => 0,
      pollIntervalMs: 1_000,
    });

    reconciler.start();
    scheduler.advance(0);
    await waitFor(() => expect(readCalls).toBe(1));

    // The first tick is still blocked inside `machine.read()`. A large jump on the fake clock must
    // not start a second tick -- there is nothing scheduled to fire, because the next tick is only
    // scheduled once this one finishes.
    expect(scheduler.timers.size).toBe(0);
    scheduler.advance(10 * DEFAULT_POLL_INTERVAL_MS);
    expect(readCalls).toBe(1);

    resolveRead?.();
    await waitFor(() => expect(scheduler.timers.size).toBe(1));
    expect(readCalls).toBe(1);

    await reconciler.stop();
  });

  it('stop() clears the pending timer, awaits an in-flight tick, and is idempotent', async () => {
    let readCalls = 0;
    let resolveRead: (() => void) | undefined;
    const machine = {
      read: async () => {
        readCalls += 1;
        await new Promise<void>((resolve) => {
          resolveRead = resolve;
        });
        return { changed: false } as never;
      },
    };
    const ticket = makeTicket({ issueNumber: 11 });
    const repos = repoStore();
    const tickets = ticketStore();
    tickets.create(ticket);
    await repos.replace([REPO]);
    const scheduler = new FakeScheduler();
    const reconciler = new PipenzoReconciler({ repos, tickets, machine, scheduler, random: () => 0 });

    // Stop before any tick ever ran: idempotent and must not throw.
    await reconciler.stop();
    await reconciler.stop();

    reconciler.start();
    scheduler.advance(0);
    await waitFor(() => expect(readCalls).toBe(1));

    let stopped = false;
    const stopping = reconciler.stop().then(() => {
      stopped = true;
    });
    // stop() must wait for the in-flight tick rather than resolving out from under it -- an
    // unawaited tick keeps spending quota after the window that wanted it has closed.
    expect(stopped).toBe(false);
    resolveRead?.();
    await stopping;
    expect(stopped).toBe(true);
    expect(scheduler.timers.size).toBe(0);

    // Nothing left scheduled, and nothing new starts even if the clock keeps moving.
    scheduler.advance(10 * DEFAULT_POLL_INTERVAL_MS);
    expect(readCalls).toBe(1);

    // Idempotent after a real stop, too.
    await reconciler.stop();
  });

  it('a stop() issued after a restart still waits for the tick that restart started, not a stale one', async () => {
    // Regression test for the `#scheduleIn` `.finally()` unconditionally clearing `#ticking`: if
    // `stop()` starts awaiting tick A and `start()` is called again before A settles, tick B gets
    // scheduled and `#ticking` moves to point at it. A settling later must not clobber `#ticking`
    // back to `undefined` while B is still running -- that would let a later `stop()` resolve
    // without actually waiting for B, which is exactly the "tick nobody waits for" failure the
    // class's own doc comments warn against.
    const resolvers: Array<() => void> = [];
    let readCalls = 0;
    const machine = {
      read: async () => {
        readCalls += 1;
        await new Promise<void>((resolve) => {
          resolvers.push(resolve);
        });
        return { changed: false } as never;
      },
    };
    const ticket = makeTicket({ issueNumber: 11 });
    const repos = repoStore();
    const tickets = ticketStore();
    tickets.create(ticket);
    await repos.replace([REPO]);
    const scheduler = new FakeScheduler();
    const reconciler = new PipenzoReconciler({
      repos,
      tickets,
      machine,
      scheduler,
      random: () => 0,
      pollIntervalMs: 1_000,
    });

    // Tick A starts and blocks inside `machine.read()`.
    reconciler.start();
    scheduler.advance(0);
    await waitFor(() => expect(readCalls).toBe(1));

    // stop() begins waiting for tick A specifically -- it must not resolve until A settles.
    let firstStopResolved = false;
    const firstStop = reconciler.stop().then(() => {
      firstStopResolved = true;
    });

    // Something restarts the loop before A has settled. This schedules and starts tick B, which
    // overlaps A -- exactly the "by construction" guarantee's edge case.
    reconciler.start();
    scheduler.advance(0);
    await waitFor(() => expect(readCalls).toBe(2));
    expect(firstStopResolved).toBe(false);

    // Releasing A lets the first stop() resolve (it was always waiting on A's own promise), but
    // must leave `#ticking` pointing at B, since B is still running.
    resolvers[0]?.();
    await firstStop;
    expect(firstStopResolved).toBe(true);

    // A second, later stop() must genuinely wait for B -- not resolve immediately because A's
    // `.finally()` already (wrongly, pre-fix) cleared `#ticking` out from under it.
    let secondStopResolved = false;
    const secondStop = reconciler.stop().then(() => {
      secondStopResolved = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(secondStopResolved).toBe(false);

    resolvers[1]?.();
    await secondStop;
    expect(secondStopResolved).toBe(true);

    // Exactly two ticks ran -- A and B -- never a third overlapping one.
    expect(readCalls).toBe(2);
  });

  it('publishes health to every subscriber and lets one unsubscribe', async () => {
    const ticket = makeTicket({ issueNumber: 11 });
    const github = new FakeGitHubClient().seedIssue(makeIssue(11, ['pipenzo:working']));
    const { repos, reconciler, scheduler } = harness({ tickets: [ticket], github });
    await repos.replace([REPO]);

    const seen: string[] = [];
    const unsubscribe = reconciler.subscribeHealth((health) => seen.push(health.state));

    reconciler.start();
    scheduler.advance(0);
    await waitFor(() => expect(seen).toContain('healthy'));

    unsubscribe();
    const countAfterUnsubscribe = seen.length;
    scheduler.advance(DEFAULT_POLL_INTERVAL_MS);
    await waitFor(() => {
      expect(reconciler.health().state).toBe('healthy');
      expect(scheduler.timers.size).toBe(1);
    });
    expect(seen.length).toBe(countAfterUnsubscribe);

    await reconciler.stop();
  });
});
