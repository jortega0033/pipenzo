import { describe, expect, it } from 'vitest';
import type { ProviderStatusV2 } from '@agent-dock/shared';
import { GITHUB_OAUTH_SCOPE } from '../../electron/github-device-flow.js';
import {
  REQUESTED_OAUTH_SCOPE,
  accountMonogram,
  connectionChip,
  isRunningOnInheritedToken,
  providerRows,
  storedOnLabel,
  tokenLocationLabel,
  unavailableReasonLabel,
} from '../../src/pipenzo/account.js';

const provider = (overrides: Partial<ProviderStatusV2> = {}): ProviderStatusV2 => {
  const id = overrides.id ?? 'claude';
  return {
    name: 'Claude Code CLI',
    installed: true,
    authenticated: 'authenticated',
    transports: [],
    capabilities: [],
    ...overrides,
    id,
    // Irrelevant to every assertion here, but `ProviderStatusV2` requires it and a loose cast
    // would stop the compiler noticing if the shape ever changed under these tests.
    sandbox: {
      providerId: id,
      platform: 'win32',
      provider: { mechanism: 'provider_policy', state: 'unknown', evidence: [] },
      agentDock: { mechanism: 'agentdock_policy', state: 'not_requested', evidence: [] },
      os: { mechanism: 'os_sandbox', state: 'unavailable', evidence: [] },
      badge: 'none',
    },
  };
};

describe('account', () => {
  /**
   * The drift this exists for is the silent one: main widening the scope it actually asks GitHub
   * for while Settings goes on telling the user it asked for `repo`. The renderer cannot import
   * `github-device-flow.ts` (it reaches for main-process APIs), so the constant is duplicated --
   * and a duplicated security-relevant constant is only safe while something fails when the two
   * disagree.
   */
  it('states the scope the device flow actually requests', () => {
    expect(REQUESTED_OAUTH_SCOPE).toBe(GITHUB_OAUTH_SCOPE);
  });

  describe('accountMonogram', () => {
    it('takes two initials, uppercased', () => {
      expect(accountMonogram('octocat')).toBe('OC');
      expect(accountMonogram('jortega0033')).toBe('JO');
    });

    it('skips the punctuation GitHub logins allow', () => {
      expect(accountMonogram('-my-name')).toBe('MY');
    });

    it('falls back rather than rendering an empty circle', () => {
      expect(accountMonogram('---')).toBe('??');
    });
  });

  describe('storedOnLabel', () => {
    it('is the day, not the minute', () => {
      expect(storedOnLabel('2026-08-12T09:41:00.000Z')).toBe('12 Aug 2026');
    });

    /** Renders nothing rather than `Invalid Date`, so the caller drops the clause. */
    it('returns undefined for anything unparseable', () => {
      expect(storedOnLabel(undefined)).toBeUndefined();
      expect(storedOnLabel('not a date')).toBeUndefined();
    });
  });

  describe('tokenLocationLabel', () => {
    it('names each source distinctly', () => {
      expect(tokenLocationLabel('vault')).toBe('Electron-main vault');
      // Issue #212: no longer names a shell variable -- the development fallback moved to a file,
      // specifically so it stops sitting in Electron main's own process environment.
      expect(tokenLocationLabel('environment')).not.toContain('PIPENZO_GITHUB_TOKEN');
      expect(tokenLocationLabel('environment')).toBe('development token file');
      expect(tokenLocationLabel('none')).toBe('no token in this daemon');
    });
  });

  /**
   * `state` describes the vault; `source` describes the credential the running daemon was handed.
   * The combination that matters is the one where they disagree -- a vault that says
   * `disconnected` while the daemon publishes with an inherited variable -- because the rule
   * against credential fallbacks is really a rule against *silent* precedence.
   */
  describe('isRunningOnInheritedToken', () => {
    it('is true on an inherited token even when the vault reports disconnected', () => {
      expect(isRunningOnInheritedToken({ state: 'disconnected', source: 'environment' })).toBe(true);
    });

    it('is false for a vault-backed daemon', () => {
      expect(
        isRunningOnInheritedToken({ state: 'connected', login: 'octocat', source: 'vault' }),
      ).toBe(false);
    });
  });

  describe('unavailableReasonLabel', () => {
    it('explains the refusal rather than printing the slug', () => {
      expect(unavailableReasonLabel('plaintext_backend')).toContain('published constant key');
      expect(unavailableReasonLabel('os_encryption_unavailable')).toContain('no OS credential store');
      expect(unavailableReasonLabel('unreadable')).toContain('cannot be decrypted');
    });

    /**
     * Issue #215: "cannot tell yet" must read differently from "this machine has no real store" --
     * conflating the two is the exact bug this reason exists to stop.
     */
    it('says this resolves on its own rather than naming a terminal problem', () => {
      const label = unavailableReasonLabel('backend_unknown');
      expect(label).toContain('Try again shortly');
      expect(label).not.toContain('published constant key');
      expect(label).not.toContain('no OS credential store');
    });

    it('still says something for a reason it does not know', () => {
      expect(unavailableReasonLabel(undefined)).toContain('cannot hold a credential');
    });
  });

  describe('connectionChip', () => {
    it('only marks a real connection with the affirmative class', () => {
      expect(connectionChip('connected').className).toContain('chip-ok');
      expect(connectionChip('unavailable').className).toContain('chip-warn');
      expect(connectionChip('disconnected').className).not.toContain('chip-ok');
    });
  });

  describe('providerRows', () => {
    it('shows the non-secret plan label beside an authenticated provider', () => {
      const [row] = providerRows([provider({ authSource: 'claude_subscription' })]);
      expect(row?.status).toBe('authenticated · claude_subscription');
      expect(row?.ok).toBe(true);
    });

    /**
     * The green tick is the whole signal a user reads off this list, so only `authenticated` earns
     * it. `unknown` means detection could not tell, which is not the same as signed in, and drawing
     * it as signed in would make the panel assert something nobody checked.
     */
    it('never marks an unknown or unauthenticated provider as ok', () => {
      expect(providerRows([provider({ authenticated: 'unknown' })])[0]).toMatchObject({
        status: 'sign-in unknown',
        ok: false,
      });
      expect(providerRows([provider({ authenticated: 'unauthenticated' })])[0]).toMatchObject({
        status: 'not signed in',
        ok: false,
      });
    });

    /** An uninstalled CLI is reported as uninstalled whatever its stale auth field says. */
    it('reports a missing CLI as not installed', () => {
      const [row] = providerRows([
        provider({ installed: false, authenticated: 'authenticated', authSource: 'chatgpt' }),
      ]);
      expect(row?.status).toBe('not installed');
      expect(row?.ok).toBe(false);
    });
  });
});
