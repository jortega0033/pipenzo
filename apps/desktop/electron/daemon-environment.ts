import type { DaemonCredentialSourceV1 } from '@agent-dock/shared';
import { resolveDaemonEntry, type ResolveDaemonEntryInput } from './resolve-daemon-entry.js';

/**
 * The environment Electron main hands the daemon sidecar (issue #165).
 *
 * ## The credential is not in here at all, and that is the point
 *
 * Before the vault, main spawned the daemon with `{ ...process.env, ... }` and the PAT rode along
 * in it. That is exactly what this ticket had to stop, for a reason that has nothing to do with
 * inheritance rules: **the daemon is the parent of every provider subprocess**, and a child can
 * read its parent's initial environment block — `cat /proc/<ppid>/environ` on Linux, the PEB on
 * Windows. A token in the daemon's environment is a token a model-directed shell command can print,
 * no matter how careful the provider-spawn allowlists are.
 *
 * So this builder **strips** every GitHub-credential-shaped variable and puts none back. The
 * credential is written to the daemon's stdin instead (see `main.ts` and the daemon's
 * `github-credential.ts`); all this function contributes is `PIPENZO_CREDENTIAL_ON_STDIN`, a
 * non-secret marker telling the daemon a message is coming so a daemon started any other way never
 * reads from a stdin it does not own.
 *
 * Stripping still matters for its original reason too: with a vault holding one token and a
 * launching shell possibly exporting another, an inherited variable would decide which credential
 * the daemon's GitHub client used, silently, by variable name.
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
 *
 * It is also not a complete answer to "which credential pushed". The **push** does not use the PAT
 * at all: `buildGitPushEnvironment` deliberately forwards `SSH_AUTH_SOCK`, `GIT_SSH_COMMAND`,
 * `XDG_CONFIG_HOME` and the DBus address so the *user's own* credential helper can answer, which is
 * the design (`pipenzo-git.ts` explains why). So an XDG-configured `credential.helper` is a second
 * answer to that question, by intent. What this module makes unambiguous is narrower and worth
 * stating precisely: **which credential the daemon's GitHub API client uses**.
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

/**
 * The variable the daemon's own `resolveGitHubToken` reads — and which this builder therefore
 * strips rather than sets. Named here so the boundary test can assert it stays stripped, and so the
 * daemon's own declaration and this one cannot silently diverge.
 */
export const DAEMON_GITHUB_TOKEN_ENV_KEY = 'PIPENZO_GITHUB_TOKEN';

/**
 * Tells the daemon a credential message is coming on stdin. Must match the daemon's
 * `CREDENTIAL_ON_STDIN_ENV_KEY`. Not a secret — it is the absence of the secret from this
 * environment that is the security property.
 */
export const CREDENTIAL_ON_STDIN_ENV_KEY = 'PIPENZO_CREDENTIAL_ON_STDIN';

export type DaemonGitHubTokenSource = 'vault' | 'environment' | 'none';

export interface DaemonGitHubTokenResolution {
  readonly token: string | undefined;
  readonly source: DaemonGitHubTokenSource;
}

/**
 * The shape a credential must have before it is handed to the daemon.
 *
 * Applied to **both** sources, not just the vault's. The vault validates on the way in, but the
 * development fallback reads a value out of a file a developer wrote by hand (`dev-token-file.ts`,
 * issue #212 -- a shell-exported variable before that), and that value becomes an HTTP
 * `Authorization` header — where a newline is request splitting. Printable, non-whitespace ASCII
 * covers every token format GitHub has issued and excludes every separator. The floor is 20 rather
 * than 8 because every real format is at least 36 characters, so a truncated paste should read as
 * "not configured" rather than as a credential that 401s later.
 */
const TOKEN_PATTERN = /^[\x21-\x7e]{20,512}$/;

export function isTokenShaped(value: string | undefined): value is string {
  return typeof value === 'string' && TOKEN_PATTERN.test(value);
}

/**
 * Decides which credential the daemon gets, and says out loud which one it was.
 *
 * The vault always wins. The development fallback is consulted **only in a development build and
 * only when the vault is empty**, which is a deliberate, narrow exception rather than a general
 * "vault, or else fallback" rule:
 *
 * - In a **packaged** app there is no exception at all. A shipped Pipenzo authenticates with the
 *   token the user connected in the UI or with nothing, full stop.
 * - In **development**, before the device-code connect step (#114) existed, the vault could not be
 *   filled at all, so this fallback was the only way a local run could authenticate — hence
 *   `developmentToken` staying supported even now that #114 has shipped and the vault is the normal
 *   path: a developer testing without going through a full device-flow sign-in each time still has
 *   a documented, opt-in way to supply one.
 *
 * `developmentToken` used to be read straight out of `process.env.PIPENZO_GITHUB_TOKEN` by main.ts's
 * own call site — sitting in **Electron main's own environment block** for the life of the app,
 * which a provider subprocess could read by walking its own PPid chain on Linux/macOS regardless of
 * what it was told to inherit (issue #212, the same reasoning issue #165 already established one
 * process further down the chain). It is now read from a file (`dev-token-file.ts`) that never
 * enters any process's environment at all -- the parameter is renamed `developmentToken` to say so.
 * The reported `source` value stays `'environment'`, deliberately not renamed to match: every
 * caller of this function outside this file (the wire schema, `AccountPanel.tsx`'s copy,
 * `startup-route.ts`) already treats that string as "not the vault, the development-only fallback
 * is in play," and none of them depend on it literally naming a shell variable. Renaming it would
 * have meant touching every one of those call sites for a label whose meaning has not changed, only
 * its delivery mechanism has.
 *
 * ## Why two gates and not just `isPackaged`
 *
 * `app.isPackaged` is not a security boundary: Electron derives it from the executable's *filename*
 * (`false` iff the binary is called `electron`). Nothing is signed and nothing is decided at build
 * time, so a shipped artifact that ships the stock binary un-renamed would silently re-enable the
 * fallback. `isDevelopmentBuild` is a constant the bundler substitutes at build time and a rename
 * cannot reach, and it defaults to `false` — the safe answer — if the substitution is ever missing.
 * Both must agree before an inherited credential is used.
 *
 * The ambiguity the rule against fallbacks exists to prevent is *silent* precedence. This returns
 * `source` so that precedence is reportable: main logs it, and it is carried on the
 * `PipenzoGitHubConnectionV1` the `pipenzo:github-connection` channel answers with.
 *
 * Reportable is not yet the same as reported. No renderer code reads that field today — the
 * pre-app shell that will show it is #113 — so at the moment "you are running on the development
 * fallback, not the account you connected" reaches a console warning and nothing a user sees. The
 * field is the mechanism; the surface is still owed.
 */
export function resolveDaemonGitHubToken(input: {
  readonly vaultToken: string | undefined;
  readonly developmentToken: string | undefined;
  readonly isPackaged: boolean;
  readonly isDevelopmentBuild: boolean;
  /**
   * Set once an operator has explicitly disconnected in this run of the app (issue #210). The
   * vault still always wins over this flag -- signing in again writes a real vault record, which
   * the check above already returns from before this one is ever reached -- but while the vault is
   * empty, an explicit disconnect must not be a no-op in a development build: without this, the
   * very next spawn falls straight back to the same development-fallback token, and "forget this
   * credential" silently becomes "keep using it". Deliberately process-lifetime, not cleared by
   * anything short of restarting the app -- the fallback exists for developer convenience, and
   * convenience is exactly what an explicit disconnect is supposed to override.
   */
  readonly developmentFallbackSuppressed?: boolean;
}): DaemonGitHubTokenResolution {
  const vaultToken = input.vaultToken?.trim();
  if (isTokenShaped(vaultToken)) return { token: vaultToken, source: 'vault' };
  if (input.isPackaged || !input.isDevelopmentBuild) return { token: undefined, source: 'none' };
  if (input.developmentFallbackSuppressed) return { token: undefined, source: 'none' };
  const developmentToken = input.developmentToken?.trim();
  if (isTokenShaped(developmentToken)) {
    return { token: developmentToken, source: 'environment' };
  }
  return { token: undefined, source: 'none' };
}

/**
 * Confirms what Electron main *intended* to send the daemon against what the daemon itself reports
 * having resolved, and reports the confirmed answer (issue #209).
 *
 * `resolveDaemonGitHubToken`'s own doc comment already names the gap this closes: its `source` is
 * reportable but not yet reported, and it describes what main *sent*, not what the daemon actually
 * ended up holding. A stdin handoff can fail silently -- `child.stdin` null, `EPIPE` against a
 * child that died on spawn, a truncated write, a message the daemon's best-effort reader could not
 * parse -- and until this function, a failed handoff still reported `intended` (e.g. `vault`) to
 * the renderer, even though the daemon had nothing and every GitHub call was about to fail
 * `token_missing`.
 *
 * `reported` comes from the daemon's own `/health` response
 * (`DaemonGitHubCredential.resolvedSource`, `@agent-dock/shared`'s `daemonCredentialSourceV1Schema`)
 * once `waitForDaemonReady` has adopted the client -- so this is a *confirmation* step, not a
 * replacement for `resolveDaemonGitHubToken`: main still has to decide what to attempt sending
 * before it knows whether the daemon received it.
 *
 * - `reported === 'injected'` means a real credential arrived over stdin, and in the shipped app
 *   that credential can only be the one main just attempted to send -- so `intended` is confirmed
 *   and returned unchanged.
 * - `reported === 'environment'` means the daemon fell back to reading its own `process.env`,
 *   which `buildDaemonEnvironment` always strips before spawning an Electron-managed daemon. Seeing
 *   it here means that strip did not hold, so it is reported honestly as `environment` rather than
 *   trusting `intended`.
 * - `reported === 'none'` means the daemon has no usable credential at all, regardless of what main
 *   attempted -- the exact silent-failure case this function exists to stop reporting as `vault`.
 */
export function reconcileDaemonTokenSource(
  intended: DaemonGitHubTokenSource,
  reported: DaemonCredentialSourceV1,
): DaemonGitHubTokenSource {
  switch (reported) {
    case 'injected':
      return intended;
    case 'environment':
      return 'environment';
    case 'none':
      return 'none';
  }
}

/**
 * The one credential message written to the daemon's stdin, as a single JSON line.
 *
 * A JSON envelope rather than a bare token so a second field never needs a second channel, and
 * newline-terminated so the daemon's reader settles on the line rather than waiting for the pipe to
 * close.
 */
export function buildDaemonCredentialMessage(token: string | undefined): string {
  return `${JSON.stringify(isTokenShaped(token) ? { githubToken: token } : {})}\n`;
}

export interface DaemonEnvironmentOptions {
  readonly appId: string;
  /**
   * Whether a credential message will be written to the child's stdin. The credential *value* is
   * deliberately not a parameter of this function: there is no argument that could put it in an
   * environment block, so there is no mistake that could.
   */
  readonly credentialOnStdin: boolean;
}

/**
 * Builds the daemon child's environment: the inherited one, minus every GitHub credential, plus
 * Pipenzo's own markers.
 */
export function buildDaemonEnvironment(
  source: Readonly<Record<string, string | undefined>>,
  options: DaemonEnvironmentOptions,
): Record<string, string | undefined> {
  const target: Record<string, string | undefined> = { ...source };
  const stripped = new Set<string>([
    ...GITHUB_CREDENTIAL_ENV_KEYS.map((key) => key.toUpperCase()),
    // Not a credential, but the daemon must never see a stale marker: an inherited `=1` would make
    // a daemon wait on a stdin nobody is going to write to.
    CREDENTIAL_ON_STDIN_ENV_KEY,
  ]);
  for (const key of Object.keys(target)) {
    if (stripped.has(key.toUpperCase())) delete target[key];
  }
  target.ELECTRON_RUN_AS_NODE = '1';
  target.AGENT_DOCK_APP_ID = options.appId;
  if (options.credentialOnStdin) target[CREDENTIAL_ON_STDIN_ENV_KEY] = '1';
  return target;
}

/** Everything `spawnDaemon` in `main.ts` needs to actually call `child_process.spawn`, computed
 * without touching `electron`, `child_process`, or any module-level state. */
export interface DaemonSpawnPlan {
  /** Passed to `spawn` as `options.cwd`. */
  readonly cwd: string;
  /** Passed to `spawn` as its own `args` parameter. */
  readonly args: readonly string[];
  /** Passed to `spawn` as `options.env` -- the daemon child's actual environment, already stripped
   * and marked (see `buildDaemonEnvironment`). Never contains the credential itself. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Written to the child's stdin verbatim, then the stream is closed. The one place the resolved
   * credential's plaintext value appears in this whole plan. */
  readonly credentialMessage: string;
  /** `resolveDaemonGitHubToken`'s own verdict -- main's pre-handoff *intent*, unconfirmed until the
   * daemon's own `/health` report lands (issue #209); not carried anywhere in `env` or the message
   * above, since nothing here needs the label, only the daemon's later confirmation does. */
  readonly credentialSource: DaemonGitHubTokenSource;
}

export interface BuildDaemonSpawnPlanInput {
  readonly entry: ResolveDaemonEntryInput;
  readonly appId: string;
  /** The parent process's own environment -- `buildDaemonEnvironment` strips from a copy of this,
   * never mutates it. Explicit rather than read from `process.env` here so a test can hand in a
   * fixture instead of this process's real one. */
  readonly parentEnv: Readonly<Record<string, string | undefined>>;
  readonly vaultToken: string | undefined;
  readonly developmentToken: string | undefined;
  readonly isPackaged: boolean;
  readonly isDevelopmentBuild: boolean;
  readonly developmentFallbackSuppressed: boolean;
}

/**
 * The whole decision `spawnDaemon` makes, before it ever calls `child_process.spawn` (issue #213).
 *
 * Pulled out specifically so the properties the token-boundary tests care about -- what environment
 * the child would actually be given, what would actually be written to its stdin -- are assertions
 * against a real returned object instead of a regex over `main.ts`'s source text. A source-regex
 * assertion tracks spellings, not properties: `github-token-boundary.test.ts`'s own history is that
 * `env: { ...buildDaemonEnvironment(...), PIPENZO_GITHUB_TOKEN: token }` would still satisfy both
 * `not.toMatch(/env:\s*\{\s*\.\.\.process\.env/)` and `toMatch(/env:\s*buildDaemonEnvironment\(/)`,
 * the exact regression those assertions exist to catch. Testing the *value* `env` resolves to
 * instead makes that regression fail for what it actually does, not for how it happens to be typed.
 *
 * `main.ts`'s own `spawnDaemon` is now a thin wrapper: build this plan from real values (`app.*`,
 * `tokenVault.readToken()`, `process.env`), then actually spawn the child and write its stdin from
 * the plan's own fields. Nothing here performs I/O or touches `electron`, so it needs no Electron
 * runtime and no real child process to test.
 */
export function buildDaemonSpawnPlan(input: BuildDaemonSpawnPlanInput): DaemonSpawnPlan {
  const { cwd, args } = resolveDaemonEntry(input.entry);
  const credential = resolveDaemonGitHubToken({
    vaultToken: input.vaultToken,
    developmentToken: input.developmentToken,
    isPackaged: input.isPackaged,
    isDevelopmentBuild: input.isDevelopmentBuild,
    developmentFallbackSuppressed: input.developmentFallbackSuppressed,
  });
  return {
    cwd,
    args,
    env: buildDaemonEnvironment(input.parentEnv, { appId: input.appId, credentialOnStdin: true }),
    credentialMessage: buildDaemonCredentialMessage(credential.token),
    credentialSource: credential.source,
  };
}
