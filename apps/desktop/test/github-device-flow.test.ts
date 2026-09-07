import { describe, expect, it, vi } from 'vitest';
import {
  DeviceFlowError,
  GITHUB_ACCESS_TOKEN_URL,
  GITHUB_DEVICE_CODE_URL,
  GITHUB_OAUTH_SCOPE,
  GITHUB_USER_URL,
  GitHubDeviceFlow,
  type DeviceCodeGrant,
} from '../electron/github-device-flow.js';

const CLIENT_ID = 'Iv1.testclientid';

/**
 * A `fetch` that answers a scripted queue, and records what it was asked.
 *
 * Running off the end of the script **throws** rather than repeating the last response. The
 * subject here is a polling loop, so a harness that answered `authorization_pending` forever would
 * turn any missing exit condition into a hung run that eats the heap instead of a failing test —
 * which is exactly what the first draft of this file did.
 */
function scriptedFetch(
  responses: { status?: number; body: unknown }[],
): { fetch: typeof globalThis.fetch; calls: { url: string; body: string; headers: Headers }[] } {
  const calls: { url: string; body: string; headers: Headers }[] = [];
  let index = 0;
  const fetchImpl = vi.fn(async (input: unknown, init?: RequestInit) => {
    calls.push({
      url: String(input),
      body: typeof init?.body === 'string' ? init.body : '',
      headers: new Headers(init?.headers),
    });
    const next = responses[index];
    index += 1;
    if (!next) throw new Error(`scripted fetch ran out of responses after ${index - 1}`);
    return {
      ok: (next.status ?? 200) < 400,
      status: next.status ?? 200,
      json: async () => next.body,
    } as Response;
  });
  return { fetch: fetchImpl as unknown as typeof globalThis.fetch, calls };
}

const DEVICE_CODE_OK = {
  device_code: 'the-device-code',
  user_code: 'WDJB-MJHT',
  verification_uri: 'https://github.com/login/device',
  expires_in: 900,
  interval: 5,
};

function flow(
  responses: { status?: number; body: unknown }[],
  overrides: Partial<{ clientId: string; now: () => number }> = {},
) {
  const scripted = scriptedFetch(responses);
  return {
    ...scripted,
    subject: new GitHubDeviceFlow({
      clientId: overrides.clientId ?? CLIENT_ID,
      fetch: scripted.fetch,
      now: overrides.now ?? (() => 1_000_000),
      // Every test that polls would otherwise spend real seconds asleep.
      sleep: async () => {},
    }),
  };
}

const grant = (overrides: Partial<DeviceCodeGrant> = {}): DeviceCodeGrant => ({
  userCode: 'WDJB-MJHT',
  verificationUri: 'https://github.com/login/device',
  expiresAt: 2_000_000,
  intervalSeconds: 5,
  deviceCode: 'the-device-code',
  ...overrides,
});

describe('GitHubDeviceFlow.requestCode', () => {
  it('asks GitHub for a code with the repo scope, as JSON', async () => {
    const { subject, calls } = flow([{ body: DEVICE_CODE_OK }]);
    const result = await subject.requestCode();

    expect(calls[0]?.url).toBe(GITHUB_DEVICE_CODE_URL);
    const body = new URLSearchParams(calls[0]?.body ?? '');
    expect(body.get('client_id')).toBe(CLIENT_ID);
    expect(body.get('scope')).toBe(GITHUB_OAUTH_SCOPE);
    expect(GITHUB_OAUTH_SCOPE).toBe('repo');
    // Without this header GitHub answers form-encoded and every parse below fails, including the
    // successful one -- so it is asserted rather than assumed.
    expect(calls[0]?.headers.get('Accept')).toBe('application/json');

    expect(result.userCode).toBe('WDJB-MJHT');
    expect(result.deviceCode).toBe('the-device-code');
    expect(result.expiresAt).toBe(1_000_000 + 900_000);
    expect(result.intervalSeconds).toBe(5);
  });

  /**
   * A build with no client id must not make a request at all. Asking GitHub anyway would produce
   * an error nobody anticipated, which would surface as "GitHub rejected the sign-in" and send
   * whoever hit it to debug their account rather than the build.
   */
  it('refuses before making any request when the build has no client id', async () => {
    const { subject, calls } = flow([{ body: DEVICE_CODE_OK }], { clientId: '' });

    await expect(subject.requestCode()).rejects.toMatchObject({ reason: 'not_configured' });
    expect(calls).toHaveLength(0);
    expect(subject.configured).toBe(false);
  });

  /**
   * The likeliest real-world setup failure: the OAuth app exists but Device Flow was never enabled
   * on it, which is off by default. It has to read as a build fault, not a user one.
   */
  it('reports device flow being disabled as a build fault', async () => {
    const { subject } = flow([{ body: { error: 'device_flow_disabled' } }]);
    await expect(subject.requestCode()).rejects.toMatchObject({ reason: 'not_configured' });
  });

  /**
   * This URL is opened in the user's own browser, and the page it leads to asks them to type a
   * code. A response pointing anywhere else is a phishing page delivered by the app itself, so
   * https alone is not enough — the host is pinned.
   */
  it('refuses a verification URL that is not on github.com', async () => {
    for (const verification_uri of [
      'https://github.com.evil.example/login/device',
      'https://evil.example/login/device',
      'http://github.com/login/device',
      'not a url',
    ]) {
      const { subject } = flow([{ body: { ...DEVICE_CODE_OK, verification_uri } }]);
      await expect(subject.requestCode()).rejects.toBeInstanceOf(DeviceFlowError);
    }
  });

  it('refuses an incomplete response rather than inventing the missing half', async () => {
    const { subject } = flow([{ body: { user_code: 'WDJB-MJHT' } }]);
    await expect(subject.requestCode()).rejects.toMatchObject({ reason: 'unreachable' });
  });

  /**
   * Both directions matter. An absurd `expires_in` would leave a dead poll running for hours; a
   * missing one would otherwise expire the grant on the very next tick.
   */
  it('clamps the lifetime GitHub claims, in both directions', async () => {
    const long = flow([{ body: { ...DEVICE_CODE_OK, expires_in: 86_400 } }]);
    expect((await long.subject.requestCode()).expiresAt).toBe(1_000_000 + 20 * 60 * 1000);

    const missing = flow([{ body: { ...DEVICE_CODE_OK, expires_in: undefined } }]);
    expect((await missing.subject.requestCode()).expiresAt).toBeGreaterThan(1_000_000);

    const slow = flow([{ body: { ...DEVICE_CODE_OK, interval: 10_000 } }]);
    expect((await slow.subject.requestCode()).intervalSeconds).toBe(60);
  });

  it('reports a transport failure as unreachable, not as a rejection by GitHub', async () => {
    const subject = new GitHubDeviceFlow({
      clientId: CLIENT_ID,
      fetch: (() => Promise.reject(new TypeError('network'))) as unknown as typeof globalThis.fetch,
    });
    await expect(subject.requestCode()).rejects.toMatchObject({ reason: 'unreachable' });
  });
});

describe('GitHubDeviceFlow.poll', () => {
  it('exchanges the device code and reports the account it belongs to', async () => {
    const { subject, calls } = flow([
      { body: { access_token: 'gho_realtoken' } },
      { body: { login: 'octocat' } },
    ]);

    expect(await subject.poll(grant())).toEqual({ token: 'gho_realtoken', login: 'octocat' });

    expect(calls[0]?.url).toBe(GITHUB_ACCESS_TOKEN_URL);
    const body = new URLSearchParams(calls[0]?.body ?? '');
    expect(body.get('device_code')).toBe('the-device-code');
    expect(body.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:device_code');
    expect(calls[1]?.url).toBe(GITHUB_USER_URL);
    expect(calls[1]?.headers.get('Authorization')).toBe('Bearer gho_realtoken');
  });

  it('keeps polling while GitHub says the user has not finished', async () => {
    const scripted = scriptedFetch([
      { body: { error: 'authorization_pending' } },
      { body: { error: 'authorization_pending' } },
      { body: { access_token: 'gho_realtoken' } },
      { body: { login: 'octocat' } },
    ]);
    const subject = new GitHubDeviceFlow({
      clientId: CLIENT_ID,
      fetch: scripted.fetch,
      now: () => 1_000_000,
      sleep: async () => {},
    });

    expect(await subject.poll(grant())).toEqual({ token: 'gho_realtoken', login: 'octocat' });
    expect(scripted.calls).toHaveLength(4);
  });

  /**
   * GitHub's documented instruction on `slow_down` is to add five seconds. The returned `interval`
   * is deliberately not honoured: a response that could name its own poll interval could pin this
   * loop for as long as it liked.
   */
  it('backs off on slow_down, and is capped', async () => {
    const slept: number[] = [];
    const scripted = scriptedFetch([
      { body: { error: 'slow_down' } },
      { body: { error: 'slow_down' } },
      { body: { access_token: 'gho_realtoken' } },
      { body: { login: 'octocat' } },
    ]);
    const subject = new GitHubDeviceFlow({
      clientId: CLIENT_ID,
      fetch: scripted.fetch,
      now: () => 1_000_000,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });

    await subject.poll(grant({ intervalSeconds: 5 }));
    expect(slept).toEqual([5000, 10_000, 15_000]);
  });

  /** A grant already at the ceiling stays there rather than climbing without bound. */
  it('caps the backoff', async () => {
    const slept: number[] = [];
    let clock = 1_000_000;
    const scripted = scriptedFetch([
      { body: { error: 'slow_down' } },
      { body: { error: 'slow_down' } },
      { body: { access_token: 'gho_realtoken' } },
      { body: { login: 'octocat' } },
    ]);
    const subject = new GitHubDeviceFlow({
      clientId: CLIENT_ID,
      fetch: scripted.fetch,
      now: () => clock,
      sleep: async (ms) => {
        slept.push(ms);
        clock += ms;
      },
    });

    await subject.poll(grant({ intervalSeconds: 58, expiresAt: 9_000_000 }));
    expect(slept).toEqual([58_000, 60_000, 60_000]);
  });

  it('maps every terminal GitHub error onto its own reason', async () => {
    for (const [error, reason] of [
      ['expired_token', 'expired'],
      ['access_denied', 'denied'],
      ['incorrect_client_credentials', 'not_configured'],
      ['unsupported_grant_type', 'not_configured'],
      ['something_new_and_unknown', 'unreachable'],
    ] as const) {
      const { subject } = flow([{ body: { error } }]);
      await expect(subject.poll(grant())).rejects.toMatchObject({ reason });
    }
  });

  /**
   * Enforced here as well as trusted to GitHub's `expired_token`: a device code that stops being
   * answered would otherwise leave the UI on "waiting" forever.
   */
  it('expires the grant on its own clock', async () => {
    let clock = 1_000_000;
    const scripted = scriptedFetch([{ body: { error: 'authorization_pending' } }]);
    const subject = new GitHubDeviceFlow({
      clientId: CLIENT_ID,
      fetch: scripted.fetch,
      now: () => clock,
      sleep: async () => {
        clock += 10_000;
      },
    });

    await expect(subject.poll(grant({ expiresAt: 1_005_000 }))).rejects.toMatchObject({
      reason: 'expired',
    });
    expect(scripted.calls).toHaveLength(0);
  });

  it('stops on cancellation without exchanging anything', async () => {
    const controller = new AbortController();
    controller.abort();
    const { subject, calls } = flow([{ body: { access_token: 'gho_realtoken' } }]);

    await expect(subject.poll(grant(), { signal: controller.signal })).rejects.toMatchObject({
      reason: 'cancelled',
    });
    expect(calls).toHaveLength(0);
  });

  /**
   * "Connected" with no account name is a state the user cannot check, and this is the one cheap
   * moment the app can confirm the token it just received actually works. So a failure here fails
   * the sign-in rather than storing a credential with an unknown owner.
   */
  it('fails the sign-in rather than storing a credential it cannot name', async () => {
    for (const account of [
      { status: 401, body: {} },
      { body: {} },
      { body: { login: '' } },
    ]) {
      const { subject } = flow([{ body: { access_token: 'gho_realtoken' } }, account]);
      await expect(subject.poll(grant())).rejects.toMatchObject({ reason: 'unreachable' });
    }
  });

  it('refuses a success that carries no token', async () => {
    const { subject } = flow([{ body: { token_type: 'bearer' } }]);
    await expect(subject.poll(grant())).rejects.toMatchObject({ reason: 'unreachable' });
  });
});
