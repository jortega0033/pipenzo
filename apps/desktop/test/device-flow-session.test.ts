import { describe, expect, it, vi } from 'vitest';
import { DeviceFlowSession, type DeviceFlowSessionDeps } from '../electron/device-flow-session.js';
import { DeviceFlowError, type DeviceCodeGrant } from '../electron/github-device-flow.js';

/**
 * The rules that decide whether a `repo`-scoped token is kept.
 *
 * This is the file the first review said was missing, and it is missing-shaped for a reason: the
 * lifecycle used to live inside `main.ts`, where no test can reach it, and the bug it hid — a
 * concurrency latch keyed on a value that only exists *after* the await it was meant to cover —
 * survived a full guardrail pass because nothing could drive it.
 */

const grant = (overrides: Partial<DeviceCodeGrant> = {}): DeviceCodeGrant => ({
  userCode: 'WDJB-MJHT',
  verificationUri: 'https://github.com/login/device',
  expiresAt: Date.now() + 900_000,
  intervalSeconds: 5,
  deviceCode: 'the-device-code',
  ...overrides,
});

/** A deferred, so a test can hold `requestCode` or `poll` open and act during the gap. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function session(overrides: Partial<DeviceFlowSessionDeps> = {}) {
  const deps: DeviceFlowSessionDeps = {
    requestCode: vi.fn(async () => grant()),
    poll: vi.fn(() => new Promise<{ token: string; login: string }>(() => {})),
    canStore: vi.fn(() => true),
    store: vi.fn(),
    isStorageFailure: vi.fn(() => false),
    report: vi.fn(),
    onStored: vi.fn(),
    ...overrides,
  };
  return { deps, subject: new DeviceFlowSession(deps) };
}

describe('DeviceFlowSession.start', () => {
  it('returns the pairing code and nothing that could be exchanged for anything', async () => {
    const { subject } = session();
    const code = await subject.start();

    expect(code).toEqual({
      userCode: 'WDJB-MJHT',
      verificationUri: 'https://github.com/login/device',
      expiresAt: expect.any(Number),
    });
    // The device code is the bearer of the pending authorization. Asserted as an absence on the
    // returned object, because the mistake this guards is a spread rather than a field-by-field
    // build, and a spread would carry it silently.
    expect(Object.keys(code).sort()).toEqual(['expiresAt', 'userCode', 'verificationUri']);
  });

  it('returns a live grant unchanged rather than minting another', async () => {
    const { subject, deps } = session();
    const first = await subject.start();
    const second = await subject.start();

    expect(second).toEqual(first);
    expect(deps.requestCode).toHaveBeenCalledTimes(1);
  });

  /**
   * The bug the review found. A grant only exists *after* `requestCode` resolves, so a latch keyed
   * on the grant leaves the whole network round trip uncovered: every call arriving during it saw
   * no grant, passed the guard, and minted its own code. Each extra flow also overwrote the
   * previous `AbortController`, orphaning a poll loop that then ran for the grant's full lifetime
   * with nothing able to stop it.
   */
  it('joins a start already in flight instead of racing it', async () => {
    const pending = deferred<DeviceCodeGrant>();
    const requestCode = vi.fn(() => pending.promise);
    const { subject, deps } = session({ requestCode });

    const all = [subject.start(), subject.start(), subject.start()];
    pending.resolve(grant());
    const codes = await Promise.all(all);

    expect(requestCode).toHaveBeenCalledTimes(1);
    expect(codes[0]).toEqual(codes[1]);
    expect(codes[1]).toEqual(codes[2]);
    // One flow, so one poll loop -- not three, two of which nothing could ever abort.
    expect(deps.poll).toHaveBeenCalledTimes(1);
  });

  it('releases the latch when a start fails, so the next one is not stuck behind it', async () => {
    const requestCode = vi
      .fn()
      .mockRejectedValueOnce(new DeviceFlowError('unreachable', 'no'))
      .mockResolvedValue(grant());
    const { subject } = session({ requestCode });

    await expect(subject.start()).rejects.toBeInstanceOf(DeviceFlowError);
    await expect(subject.start()).resolves.toMatchObject({ userCode: 'WDJB-MJHT' });
    expect(requestCode).toHaveBeenCalledTimes(2);
  });

  it('mints a new code once the live one has expired', async () => {
    const requestCode = vi
      .fn()
      .mockResolvedValueOnce(grant({ expiresAt: Date.now() - 1, userCode: 'OLD1-OLD1' }))
      .mockResolvedValue(grant({ userCode: 'NEW1-NEW1' }));
    const { subject } = session({ requestCode });

    await subject.start();
    expect((await subject.start()).userCode).toBe('NEW1-NEW1');
  });

  /**
   * The renderer disables its button when the vault cannot store, but a disabled attribute is a
   * suggestion, not a refusal — and the cost of being wrong is issuing a live `repo` token that a
   * public client has no way to revoke. So the refusal is here too, before any request is made.
   */
  it('refuses before asking GitHub for anything when there is nowhere to store the result', async () => {
    const { subject, deps } = session({ canStore: () => false });

    await expect(subject.start()).rejects.toBeInstanceOf(DeviceFlowError);
    expect(deps.requestCode).not.toHaveBeenCalled();
  });
});

describe('DeviceFlowSession outcomes', () => {
  it('stores the credential, restarts the daemon, and reports connected — in that order', async () => {
    const order: string[] = [];
    const poll = vi.fn(async () => ({ token: 'gho_realtoken', login: 'octocat' }));
    const { subject, deps } = session({
      poll,
      store: vi.fn(() => void order.push('store')),
      onStored: vi.fn(() => void order.push('restart')),
      report: vi.fn(() => void order.push('report')),
    });

    await subject.start();
    await vi.waitFor(() => expect(deps.report).toHaveBeenCalled());

    expect(deps.store).toHaveBeenCalledWith({ token: 'gho_realtoken', login: 'octocat' });
    expect(deps.report).toHaveBeenCalledWith({ state: 'connected' });
    // The daemon must be handed the new credential before the UI is told it is connected, or the
    // screen routes onward to an app still running on the old one.
    expect(order).toEqual(['store', 'restart', 'report']);
  });

  it('maps a flow failure onto its own reason', async () => {
    for (const [reason, wire] of [
      ['expired', 'expired'],
      ['denied', 'denied'],
      ['not_configured', 'not_configured'],
      ['unreachable', 'unreachable'],
    ] as const) {
      const { subject, deps } = session({
        poll: vi.fn(async () => {
          throw new DeviceFlowError(reason, 'x');
        }),
      });
      await subject.start();
      await vi.waitFor(() => expect(deps.report).toHaveBeenCalled());
      expect(deps.report).toHaveBeenCalledWith({ state: 'failed', reason: wire });
    }
  });

  it('reports an unrecognised throw as unreachable rather than letting it escape', async () => {
    const { subject, deps } = session({
      poll: vi.fn(async () => {
        throw new TypeError('something else entirely');
      }),
    });
    await subject.start();
    await vi.waitFor(() => expect(deps.report).toHaveBeenCalled());
    expect(deps.report).toHaveBeenCalledWith({ state: 'failed', reason: 'unreachable' });
  });

  /**
   * A vault that cannot encrypt is a different failure from a vault that rejected the value.
   * Reporting a malformed login as "this machine has nowhere to keep the token" sends the user to
   * debug a keyring that is working perfectly.
   */
  it('separates a vault that cannot store from a vault that refused the value', async () => {
    const poll = vi.fn(async () => ({ token: 'gho_realtoken', login: 'octocat' }));
    const cannotStore = session({
      poll,
      store: vi.fn(() => {
        throw new Error('encryption_unavailable');
      }),
      isStorageFailure: () => true,
    });
    await cannotStore.subject.start();
    await vi.waitFor(() => expect(cannotStore.deps.report).toHaveBeenCalled());
    expect(cannotStore.deps.report).toHaveBeenCalledWith({
      state: 'failed',
      reason: 'storage_unavailable',
    });

    const refusedValue = session({
      poll,
      store: vi.fn(() => {
        throw new Error('invalid_login');
      }),
      isStorageFailure: () => false,
    });
    await refusedValue.subject.start();
    await vi.waitFor(() => expect(refusedValue.deps.report).toHaveBeenCalled());
    expect(refusedValue.deps.report).toHaveBeenCalledWith({
      state: 'failed',
      reason: 'unreachable',
    });
  });

  it('never restarts the daemon for a credential it did not store', async () => {
    const { subject, deps } = session({
      poll: vi.fn(async () => ({ token: 'gho_realtoken', login: 'octocat' })),
      store: vi.fn(() => {
        throw new Error('nope');
      }),
      isStorageFailure: () => true,
    });
    await subject.start();
    await vi.waitFor(() => expect(deps.report).toHaveBeenCalled());
    expect(deps.onStored).not.toHaveBeenCalled();
  });
});

describe('DeviceFlowSession cancellation', () => {
  it('reports cancelled, once, and is idempotent afterwards', async () => {
    const { subject, deps } = session();
    await subject.start();

    subject.cancel();
    subject.cancel();
    expect(deps.report).toHaveBeenCalledTimes(1);
    expect(deps.report).toHaveBeenCalledWith({ state: 'failed', reason: 'cancelled' });
  });

  it('does nothing when there is no sign-in to cancel', () => {
    const { subject, deps } = session();
    subject.cancel();
    expect(deps.report).not.toHaveBeenCalled();
  });

  it('aborts the poll it started', async () => {
    let seen: AbortSignal | undefined;
    const { subject } = session({
      poll: vi.fn((_grant, options) => {
        seen = options.signal;
        return new Promise<{ token: string; login: string }>(() => {});
      }),
    });

    await subject.start();
    expect(seen?.aborted).toBe(false);
    subject.cancel();
    expect(seen?.aborted).toBe(true);
  });

  /**
   * The single most security-relevant line in this feature. A credential arriving after the user
   * pressed Cancel is one they did not consent to keep -- and because a device flow is a public
   * client with no secret, storing it anyway would leave a `repo` token this app can never revoke.
   */
  it('refuses to store a credential that lands after a cancel', async () => {
    const pending = deferred<{ token: string; login: string }>();
    const { subject, deps } = session({ poll: vi.fn(() => pending.promise) });

    await subject.start();
    subject.cancel();
    pending.resolve({ token: 'gho_realtoken', login: 'octocat' });
    await pending.promise;
    await Promise.resolve();

    expect(deps.store).not.toHaveBeenCalled();
    expect(deps.onStored).not.toHaveBeenCalled();
    // And the cancel is the only thing it ever said.
    expect(deps.report).toHaveBeenCalledTimes(1);
    expect(deps.report).toHaveBeenCalledWith({ state: 'failed', reason: 'cancelled' });
  });

  /** The same rule for a *failure* that lands late: a superseded flow must not narrate the UI. */
  it('stays silent about a failure that lands after a cancel', async () => {
    const pending = deferred<{ token: string; login: string }>();
    const { subject, deps } = session({ poll: vi.fn(() => pending.promise) });

    await subject.start();
    subject.cancel();
    pending.reject(new DeviceFlowError('expired', 'too late'));
    await pending.promise.catch(() => {});
    await Promise.resolve();

    expect(deps.report).toHaveBeenCalledTimes(1);
    expect(deps.report).toHaveBeenCalledWith({ state: 'failed', reason: 'cancelled' });
  });

  it('abandons silently, for a shutdown with no window left to tell', async () => {
    const { subject, deps } = session();
    await subject.start();

    subject.abandon();
    expect(deps.report).not.toHaveBeenCalled();
    expect(subject.verificationUri).toBeUndefined();
  });
});

describe('DeviceFlowSession.verificationUri', () => {
  it('is main’s own copy, and is gone once the flow ends', async () => {
    const { subject } = session();
    expect(subject.verificationUri).toBeUndefined();

    await subject.start();
    expect(subject.verificationUri).toBe('https://github.com/login/device');

    subject.cancel();
    expect(subject.verificationUri).toBeUndefined();
  });
});
