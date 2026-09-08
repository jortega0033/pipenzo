import type {
  PipenzoCredentialSourceV1,
  PipenzoCredentialUnavailableReasonV1,
  PipenzoGitHubConnectionV1,
  ProviderStatusV2,
} from '@agent-dock/shared';

/**
 * The derived text of Settings' Account panel (issue #130), kept out of the component.
 *
 * Every function here turns one wire value into one thing a human reads. They live in a module
 * rather than inline in JSX because each one is a claim about a credential — where it is, which one
 * the daemon is actually running on, whether a provider is authenticated — and a claim about a
 * credential is worth a test that names it. A `?:` chain inside a `<span>` is not.
 */

/**
 * The scope the device flow asks GitHub for.
 *
 * `GITHUB_OAUTH_SCOPE` in `electron/github-device-flow.ts` is the value that actually goes on the
 * wire, and the renderer cannot import it — that module reaches for `net` and belongs to main. So
 * this is a copy, and `account.test.ts` imports both and asserts they are equal, because the
 * failure this guards against is the silent one: main widening the scope it requests while Settings
 * goes on telling the user it asked for `repo`.
 *
 * `DeviceCodeStep` states the same word as literal JSX during the connect flow; this is the same
 * fact read back afterwards.
 */
export const REQUESTED_OAUTH_SCOPE = 'repo';

/**
 * Where a human revokes Pipenzo's access themselves (issue #210).
 *
 * Device flow is a public client with no client secret (see `github-oauth-app.ts`), so Pipenzo
 * cannot call GitHub's Applications API to revoke a token on the user's behalf -- that API
 * authenticates with `client_id:client_secret`, which does not exist here and cannot be
 * manufactured for a distributed desktop app. "Disconnect" therefore forgets the token locally; it
 * never revokes it on GitHub. This is the one honest alternative the fix for #210 has: a direct
 * link to the page a human uses to actually revoke it, plainly labelled so the two are never
 * confused. `DeviceCodeStep.tsx`'s `cancelled` failure copy already names this same page in prose
 * for a different moment in the flow; this is the same fact, linked, for the disconnect moment.
 */
export const GITHUB_AUTHORIZED_APPS_URL = 'https://github.com/settings/applications';

/** Two letters for the identity avatar. Uppercase, because it reads as initials rather than a name. */
export function accountMonogram(login: string): string {
  const alphanumeric = login.replace(/[^A-Za-z0-9]/g, '');
  return (alphanumeric.slice(0, 2) || '??').toUpperCase();
}

/**
 * `12 Aug 2026` — the day, not the minute.
 *
 * When a credential was stored is a fact somebody checks to answer "is this still the token I made
 * in August", and a time of day answers nothing they were asking. Returns `undefined` rather than
 * `Invalid Date` for anything unparseable, so the caller drops the clause instead of rendering it.
 */
export function storedOnLabel(storedAt: string | undefined): string | undefined {
  if (storedAt === undefined) return undefined;
  const at = new Date(storedAt);
  if (Number.isNaN(at.getTime())) return undefined;
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(at);
}

/**
 * Where the token the *running daemon* is using came from.
 *
 * This is `source`, deliberately not `state`, and the two can disagree: a development build whose
 * vault is empty may still be running on an inherited `PIPENZO_GITHUB_TOKEN` (see
 * `resolveDaemonGitHubToken`). `daemon-environment.ts` says of that field, in as many words, that
 * "the field is the mechanism; the surface is still owed" — this panel is the surface, so the
 * environment case is named rather than smoothed into "connected".
 */
export function tokenLocationLabel(source: PipenzoCredentialSourceV1): string {
  switch (source) {
    case 'vault':
      return 'Electron-main vault';
    case 'environment':
      return 'PIPENZO_GITHUB_TOKEN (inherited)';
    case 'none':
      return 'no token in this daemon';
  }
}

/**
 * True when the daemon is publishing with a shell variable rather than with the account above it.
 *
 * The rule against credential fallbacks is really a rule against *silent* precedence, so this is
 * the one combination the panel raises a notice for rather than printing in a row.
 */
export function isRunningOnInheritedToken(connection: PipenzoGitHubConnectionV1): boolean {
  return connection.source === 'environment';
}

/** Why this machine cannot hold a credential, in a sentence rather than a slug. */
export function unavailableReasonLabel(
  reason: PipenzoCredentialUnavailableReasonV1 | undefined,
): string {
  switch (reason) {
    case 'os_encryption_unavailable':
      return 'This machine reported no OS credential store, so there is nowhere to keep a token safely.';
    case 'plaintext_backend':
      return 'The only store available here encrypts with a published constant key, which is obfuscation rather than encryption. Pipenzo refuses it rather than keep a token under a false claim.';
    case 'unreadable':
      return 'A stored record exists but cannot be decrypted on this machine — usually a keyring that has been replaced or removed.';
    case undefined:
      // Spelled out rather than left to `default:`, so that adding a member to
      // `pipenzoCredentialUnavailableReasonV1Schema` fails the build here instead of silently
      // rendering the vague sentence for a reason somebody went to the trouble of naming.
      return 'This machine cannot hold a credential right now.';
  }
}

export interface AccountChip {
  readonly label: string;
  readonly className: string;
}

export function connectionChip(state: PipenzoGitHubConnectionV1['state']): AccountChip {
  switch (state) {
    case 'connected':
      return { label: 'connected', className: 'chip chip-ok' };
    case 'unavailable':
      return { label: 'unavailable', className: 'chip chip-warn' };
    case 'disconnected':
      return { label: 'not connected', className: 'chip' };
  }
}

export interface ProviderRow {
  readonly id: string;
  readonly name: string;
  /** The right-hand mono line: what is known about this provider's own credential. */
  readonly status: string;
  /** Whether the leading dot is the "good" one. Only a genuinely authenticated provider earns it. */
  readonly ok: boolean;
}

/**
 * The provider rows, from agentdock's own detection.
 *
 * Pipenzo neither sees nor stores these credentials — the CLIs hold their own, which is the point
 * of the "brought by you, not by Pipenzo" tag beside the heading. So every field here is a report
 * of what detection found, and `unknown` stays `unknown`: a provider whose auth state could not be
 * determined is not quietly drawn as authenticated, because the green tick is the whole signal a
 * user reads off this list.
 *
 * `authSource` is a non-secret plan label (`chatgpt`, `claude_subscription`, …) and never account
 * identity, which is why it can be shown at all.
 */
export function providerRows(providers: readonly ProviderStatusV2[]): readonly ProviderRow[] {
  return providers.map((provider) => {
    if (!provider.installed) {
      return { id: provider.id, name: provider.name, status: 'not installed', ok: false };
    }
    const source = provider.authSource !== undefined ? ` · ${provider.authSource}` : '';
    switch (provider.authenticated) {
      case 'authenticated':
        return {
          id: provider.id,
          name: provider.name,
          status: `authenticated${source}`,
          ok: true,
        };
      case 'unauthenticated':
        return { id: provider.id, name: provider.name, status: 'not signed in', ok: false };
      case 'unknown':
        return { id: provider.id, name: provider.name, status: 'sign-in unknown', ok: false };
    }
  });
}
