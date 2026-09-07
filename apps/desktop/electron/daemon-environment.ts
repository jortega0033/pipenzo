/**
 * The environment Electron main hands the daemon sidecar (issue #165).
 *
 * ## What changed, and why it is not a detail
 *
 * Before the vault, main spawned the daemon with `{ ...process.env, ... }`. That was fine while the
 * PAT came from the operator's own shell — the daemon inheriting it *was* the delivery mechanism.
 * With a vault it is no longer fine, for a reason the GitHub client already writes down about
 * `GITHUB_TOKEN`: a publish gate must never be ambiguous about *which credential just pushed*. If
 * the vault holds one token and the launching shell exports another, an inherited environment
 * decides that question silently, by variable name, in a file nobody looks at.
 *
 * So this builder makes the answer explicit: every GitHub-credential-shaped variable is stripped
 * from the inherited environment, and exactly one is put back — the one the caller passed, from a
 * source the caller can name. There is no path by which a credential reaches the daemon without
 * appearing as an argument to this function.
 *
 * ## Why case-insensitive stripping
 *
 * Windows environment variable names are case-insensitive, so a `Github_Token` in the parent
 * process is the same variable as `GITHUB_TOKEN` to anything that reads it there. Deleting only the
 * exact-case key would leave the value in place under a different spelling — the same trap
 * `copyCanonicalEnvKeys` in the agent runtime exists to avoid on the allowlist side.
 *
 * ## What this is *not*
 *
 * It is not an allowlist. The daemon is Pipenzo's own trusted process and legitimately needs the
 * user's `PATH`, proxy settings, `HOME`, and everything else; the default-deny allowlist belongs one
 * level down, at the provider-subprocess boundary (`buildLegacyProviderEnvironment`) and the git
 * boundary (`buildGitEnvironment`), which is where untrusted code actually runs. This is a
 * denylist for one specific class of value that must have exactly one source.
 */

/**
 * Every variable name a GitHub credential is conventionally carried in.
 *
 * `PIPENZO_GITHUB_TOKEN` is the one the daemon reads. The rest are here because tools the daemon
 * or its children may invoke read *them*: `gh` reads `GH_TOKEN` then `GITHUB_TOKEN`, and both
 * enterprise names for a GitHub Enterprise host. Leaving those inherited would mean the publish
 * path could authenticate as a credential Pipenzo never chose.
 */
export const GITHUB_CREDENTIAL_ENV_KEYS = Object.freeze([
  'PIPENZO_GITHUB_TOKEN',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
] as const);

/** The variable the daemon's own `resolveGitHubToken` reads. Kept in sync by a boundary test. */
export const DAEMON_GITHUB_TOKEN_ENV_KEY = 'PIPENZO_GITHUB_TOKEN';

export type DaemonGitHubTokenSource = 'vault' | 'environment' | 'none';

export interface DaemonGitHubTokenResolution {
  readonly token: string | undefined;
  readonly source: DaemonGitHubTokenSource;
}

/**
 * Decides which credential the daemon gets, and says out loud which one it was.
 *
 * The vault always wins. The inherited environment is consulted **only in a development build and
 * only when the vault is empty**, which is a deliberate, narrow exception rather than a general
 * "vault, or else env" fallback:
 *
 * - In a **packaged** app there is no exception at all. A shipped Pipenzo authenticates with the
 *   token the user connected in the UI or with nothing, full stop. That is what makes "which
 *   credential just pushed" answerable from the UI alone.
 * - In **development** the vault cannot be filled until the device-code connect step (#114) is
 *   built, and the repository's own live-run harness starts the daemon from an exported PAT. Losing
 *   that would mean this ticket broke every existing local workflow to deliver a vault nothing can
 *   write to yet.
 *
 * The ambiguity the rule against fallbacks exists to prevent is *silent* precedence. This returns
 * `source` precisely so nothing about it is silent: main logs it, and the connection status the
 * renderer sees carries it, so "you are publishing with a shell variable, not with the account you
 * connected" is a visible state rather than an inference.
 */
export function resolveDaemonGitHubToken(input: {
  readonly vaultToken: string | undefined;
  readonly environmentToken: string | undefined;
  readonly isPackaged: boolean;
}): DaemonGitHubTokenResolution {
  const vaultToken = input.vaultToken?.trim();
  if (vaultToken) return { token: vaultToken, source: 'vault' };
  if (input.isPackaged) return { token: undefined, source: 'none' };
  const environmentToken = input.environmentToken?.trim();
  if (environmentToken) return { token: environmentToken, source: 'environment' };
  return { token: undefined, source: 'none' };
}

export interface DaemonEnvironmentOptions {
  readonly appId: string;
  /** The one credential the daemon is allowed to have, or nothing. Never read from `source`. */
  readonly githubToken?: string | undefined;
}

/**
 * Builds the daemon child's environment: the inherited one, minus every GitHub credential, plus
 * Pipenzo's own three variables.
 */
export function buildDaemonEnvironment(
  source: Readonly<Record<string, string | undefined>>,
  options: DaemonEnvironmentOptions,
): Record<string, string | undefined> {
  const target: Record<string, string | undefined> = { ...source };
  const stripped = new Set(GITHUB_CREDENTIAL_ENV_KEYS.map((key) => key.toUpperCase()));
  for (const key of Object.keys(target)) {
    if (stripped.has(key.toUpperCase())) delete target[key];
  }
  target.ELECTRON_RUN_AS_NODE = '1';
  target.AGENT_DOCK_APP_ID = options.appId;
  const token = options.githubToken?.trim();
  if (token) target[DAEMON_GITHUB_TOKEN_ENV_KEY] = token;
  return target;
}
