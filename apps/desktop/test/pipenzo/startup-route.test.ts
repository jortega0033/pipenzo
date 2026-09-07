import { describe, expect, it } from 'vitest';
import type { PipenzoGitHubConnectionV1 } from '@agent-dock/shared';
import { routePipenzoStartup } from '../../src/pipenzo/startup-route.js';

const connection = (
  overrides: Partial<PipenzoGitHubConnectionV1> = {},
): PipenzoGitHubConnectionV1 => ({
  state: 'connected',
  login: 'octocat',
  storedAt: '2026-01-01T00:00:00.000Z',
  source: 'vault',
  ...overrides,
});

describe('routePipenzoStartup', () => {
  it('answers `loading` until the connection has been read', () => {
    expect(routePipenzoStartup({ connection: undefined })).toEqual({ screen: 'loading' });
  });

  it('sends a connected install to the app', () => {
    expect(routePipenzoStartup({ connection: connection() })).toEqual({
      screen: 'app',
      environmentCredential: false,
    });
  });

  it('sends a token-less install to the pre-app at step 1', () => {
    expect(
      routePipenzoStartup({ connection: connection({ state: 'disconnected', source: 'none' }) }),
    ).toEqual({ screen: 'pre-app', step: 'device-code', canChooseRepos: false });
  });

  /**
   * The whole reason this decision reads `source` rather than `state`. A development build with an
   * empty vault and a `PIPENZO_GITHUB_TOKEN` in its environment has a daemon that can reach GitHub
   * *this run*; sending it to "Connect GitHub" would be false, and connecting from there would
   * write to a vault the running daemon is not reading.
   */
  it('treats an inherited environment token as a real credential, and flags it', () => {
    expect(
      routePipenzoStartup({
        connection: connection({ state: 'disconnected', source: 'environment' }),
      }),
    ).toEqual({ screen: 'app', environmentCredential: true });
  });

  it('carries the reason a machine cannot hold a credential at all', () => {
    expect(
      routePipenzoStartup({
        connection: connection({
          state: 'unavailable',
          reason: 'plaintext_backend',
          source: 'none',
        }),
      }),
    ).toEqual({
      screen: 'pre-app',
      step: 'device-code',
      canChooseRepos: false,
      unavailableReason: 'plaintext_backend',
    });
  });

  /** A healthy machine with an empty vault has nothing to explain, so it explains nothing. */
  it('omits the reason for an ordinary disconnected vault', () => {
    const route = routePipenzoStartup({
      connection: connection({ state: 'disconnected', source: 'none' }),
    });
    expect(route).not.toHaveProperty('unavailableReason');
  });

  /**
   * `state` and `source` are independent, so an unreadable vault can coexist with a daemon running
   * on an inherited variable. Pinning the intended answer because it is the combination most likely
   * to look like a bug later: the reason is dropped on purpose. It exists to explain why
   * *connecting* cannot work, and this install is not blocked from anything -- it can reach GitHub
   * right now, and the banner names what it is using.
   */
  it('sends an unreadable vault with a working environment token to the app, without the reason', () => {
    expect(
      routePipenzoStartup({
        connection: connection({
          state: 'unavailable',
          reason: 'unreadable',
          source: 'environment',
        }),
      }),
    ).toEqual({ screen: 'app', environmentCredential: true });
  });

  describe('step selection', () => {
    const tokenless = { connection: connection({ state: 'disconnected', source: 'none' }) };

    it('refuses a requested step 2 while there is no credential behind it', () => {
      expect(routePipenzoStartup({ ...tokenless, requestedStep: 'choose-repos' })).toMatchObject({
        step: 'device-code',
        canChooseRepos: false,
      });
    });

    it('honours a requested step 1 once step 2 is reachable', () => {
      // Going back matters: the device code is single-use and expiring, so "show me that again" is
      // a real request rather than a stray click.
      expect(
        routePipenzoStartup({
          connection: connection(),
          connectedRepos: 0,
          requestedStep: 'device-code',
        }),
      ).toMatchObject({ step: 'device-code', canChooseRepos: true });
    });

    it('lands a credentialed install with no repos chosen on step 2', () => {
      expect(routePipenzoStartup({ connection: connection(), connectedRepos: 0 })).toEqual({
        screen: 'pre-app',
        step: 'choose-repos',
        canChooseRepos: true,
      });
    });

    it('lets a credentialed install with repos chosen through', () => {
      expect(routePipenzoStartup({ connection: connection(), connectedRepos: 3 })).toEqual({
        screen: 'app',
        environmentCredential: false,
      });
    });
  });

  /**
   * The default, and the one that is easy to get wrong later. Nothing in this app records a
   * connected-repos list yet (#115 is what will), and treating "no list" as "an empty list" would
   * park every correctly-credentialed user on a repo picker that does not exist, permanently.
   */
  it('does not gate on a connected-repos list nothing writes yet', () => {
    expect(routePipenzoStartup({ connection: connection() })).toMatchObject({ screen: 'app' });
    expect(
      routePipenzoStartup({ connection: connection(), connectedRepos: 'not-tracked' }),
    ).toMatchObject({ screen: 'app' });
  });
});
