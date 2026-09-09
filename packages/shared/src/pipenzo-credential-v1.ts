import { z } from 'zod';

/**
 * The shape a GitHub token must have before anything in Pipenzo will accept it (issue #214):
 * printable, non-whitespace ASCII, 20-512 characters. Covers every format GitHub has issued
 * (`ghp_`, `gho_`, `github_pat_`, the 40-hex classic) and excludes every separator -- this value
 * becomes an HTTP `Authorization` header and travels down a newline-terminated stdin message, so a
 * newline would frame a second message or split a request. The floor is 20 rather than 8 because
 * every real format is at least 36 characters, so a truncated paste reads as "not configured" rather
 * than as a credential that 401s later.
 *
 * Declared once here and imported by every file that checks it --
 * `apps/desktop/electron/github-token-vault.ts`, `apps/desktop/electron/daemon-environment.ts`, and
 * `apps/daemon/src/github-credential.ts` all had their own identical copy before this. Token-pattern
 * divergence between them fails closed (a value one rejects falls through to a stripped environment
 * and then `token_missing`), so the risk was genuinely low, but the repo already treats this class of
 * drift seriously elsewhere -- `CREDENTIAL_ON_STDIN_ENV_KEY` has a cross-file sync test -- and a
 * single hoisted source is cheaper than either three copies or three tests keeping them in sync.
 */
export const GITHUB_TOKEN_SHAPE_PATTERN = /^[\x21-\x7e]{20,512}$/;

/**
 * A GitHub login, by GitHub's own rules (issue #214). Shared between `github-token-vault.ts` (which
 * validates a login on the way in and re-validates it on the way back out, since it round-trips
 * through disk), this schema's own `login`/`assignee` fields, and `apps/daemon/src/github-client.ts`'s
 * `assertLogin`. Unlike the token pattern above, a divergence here does not fail closed: the vault
 * could return `connected` with a login this schema's old, separately-written copy of the same regex
 * rejected, and `pipenzo:github-connection` would throw permanently instead of degrading --
 * precisely the bug class this file's `storedAt` re-validation (see `github-token-vault.ts`) already
 * exists to prevent for a different field.
 *
 * One exception, left as-is rather than forced through this constant: `github-client.ts`'s
 * `parseRepoRef` embeds this exact character class as a capture group inside one combined
 * `owner/repo` regex, not as a standalone login check. Rewriting that one to interpolate
 * `GITHUB_LOGIN_PATTERN.source` would trade a plainly-readable literal for a harder-to-read
 * construction just to avoid a fourth copy of an already-simple pattern; noted here so this doc
 * comment does not overstate what got hoisted.
 */
export const GITHUB_LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

/**
 * What the renderer is allowed to know about Pipenzo's GitHub credential (issue #165).
 *
 * ## The shape is the security property
 *
 * There is no field here that carries a token, and there is no variant that could. That is not an
 * oversight to be filled in later by whoever builds the connect UI — it is the contract. Epic #4's
 * rule is that the token reaches the Electron-main vault and nothing else, and a wire schema with a
 * `token` field is how that rule would be lost: once the shape allows it, some handler eventually
 * populates it, and the renderer (a sandboxed context that renders model-authored text) is holding
 * a `repo`-scoped credential.
 *
 * The same reasoning runs in the other direction. The device-code flow (#114) is executed **in
 * main** — main asks GitHub for the code, main polls, main receives the token, main stores it. The
 * renderer's whole part is "show this user code" and "tell me when it worked", so there is no
 * request schema here that carries a credential *into* main either. The only thing the renderer can
 * ask for is a disconnect, which needs no payload at all.
 */

/** Why a machine cannot hold a credential, when it cannot. See `github-token-vault.ts`. */
export const pipenzoCredentialUnavailableReasonV1Schema = z.enum([
  /** The OS reported no credential store at all. */
  'os_encryption_unavailable',
  /**
   * Linux, Electron's `basic_text` backend: a published constant key, which is obfuscation rather
   * than encryption. Refused rather than used, so a token is never stored under a false claim.
   */
  'plaintext_backend',
  /**
   * Linux only (issue #215): the backend accessor exists but threw rather than naming a backend --
   * a failure of that one introspection call, not the same thing as `os_encryption_unavailable`'s
   * own pre-`ready` race (`isEncryptionAvailable()` is checked first and already reports that one
   * before this accessor is ever reached). "Cannot tell yet, ask again shortly," not "this machine
   * has no real credential store" -- kept distinct from `plaintext_backend` because a renderer wants
   * to say something different for each: one may resolve on its own, the other is terminal until the
   * user sets up a keyring. `account.ts`'s `unavailableReasonLabel` and `DeviceCodeStep.tsx`'s
   * `UNAVAILABLE_COPY` both already give it that different copy.
   */
  'backend_unknown',
  /** A record exists but cannot be read or decrypted here — a keyring that went away, say. */
  'unreadable',
]);

export type PipenzoCredentialUnavailableReasonV1 = z.infer<
  typeof pipenzoCredentialUnavailableReasonV1Schema
>;

/**
 * Where the daemon's credential actually came from this run.
 *
 * Carried on the wire rather than left to inference, because a development build may still fall
 * back to a development-only token when the vault is empty (a file under Electron's own data
 * directory since issue #212 — an inherited `PIPENZO_GITHUB_TOKEN` shell variable before that; see
 * `daemon-environment.ts`). "You are publishing with the development fallback, not with the
 * account shown here" has to be a *visible* state — the rule against credential fallbacks is
 * really a rule against **silent** precedence.
 *
 * One honest limit on that, so this field is not mistaken for more than it is: it is not yet
 * rendered anywhere (#113 owns the pre-app shell that will show it).
 *
 * It used to describe only what Electron main *sent*, which a failed stdin handoff (a truncated
 * write, `EPIPE` against a child that died on spawn) could report as `vault` even though the daemon
 * ended up with nothing (issue #209). Main now confirms this against
 * `daemonCredentialSourceV1Schema`, the daemon's own report of what it actually resolved, over the
 * `/health` channel (`reconcileDaemonTokenSource` in `daemon-environment.ts`) before setting this
 * field — a daemon that reports `none` is never papered over with main's pre-handoff intent.
 */
export const pipenzoCredentialSourceV1Schema = z.enum(['vault', 'environment', 'none']);

export type PipenzoCredentialSourceV1 = z.infer<typeof pipenzoCredentialSourceV1Schema>;

/**
 * What the *daemon itself* can honestly say about where its credential came from (issue #209) —
 * a narrower, differently-shaped question than `pipenzoCredentialSourceV1Schema` above.
 *
 * The daemon cannot tell a vault-sourced token from a development-environment-sourced one: both
 * arrive identically over stdin as `DaemonGitHubCredential.fromStartup`'s one JSON message (see
 * `apps/desktop/electron/main.ts`'s `spawnDaemon`, which writes *either* source down the same
 * pipe). What the daemon *can* say, honestly, from its own state:
 *
 * - `injected` — a credential arrived over stdin and is what `resolve()` uses. In the shipped app
 *   this is the only way a real credential ever reaches the daemon, so it confirms whatever
 *   Electron main most recently attempted to send actually landed intact.
 * - `environment` — nothing arrived over stdin, but the daemon's own `process.env` held a usable
 *   `PIPENZO_GITHUB_TOKEN`. Electron main always strips that variable before spawning the daemon
 *   (`buildDaemonEnvironment`), so this case is expected only for a daemon nobody's Electron main
 *   started (a direct `pnpm dev`, the live-smoke harness, CI) — seeing it from an Electron-spawned
 *   daemon means the strip did not happen and is worth surfacing rather than assuming away.
 * - `none` — neither. The daemon has no usable credential at all.
 */
export const daemonCredentialSourceV1Schema = z.enum(['injected', 'environment', 'none']);

export type DaemonCredentialSourceV1 = z.infer<typeof daemonCredentialSourceV1Schema>;

export const pipenzoGitHubConnectionV1Schema = z.object({
  state: z.enum(['connected', 'disconnected', 'unavailable']),
  /** Present only when `state` is `connected`. GitHub's own login rules. */
  login: z.string().regex(GITHUB_LOGIN_PATTERN).optional(),
  /** When the credential was stored, ISO-8601. Present only when `state` is `connected`. */
  storedAt: z.string().datetime({ offset: true }).optional(),
  /** Present only when `state` is `unavailable`. */
  reason: pipenzoCredentialUnavailableReasonV1Schema.optional(),
  /**
   * Which credential the *running daemon* is actually using. Deliberately independent of `state`:
   * a vault can be `disconnected` while a development daemon runs on an inherited variable, and
   * that combination is exactly the one a user needs to see rather than infer.
   */
  source: pipenzoCredentialSourceV1Schema,
});

export type PipenzoGitHubConnectionV1 = z.infer<typeof pipenzoGitHubConnectionV1Schema>;

/**
 * ## The device-code flow's wire shapes (issue #114)
 *
 * The same rule as above, applied to a flow that briefly holds *two* secrets rather than one.
 *
 * A device flow has a `device_code` as well as an access token, and the `device_code` is the bearer
 * of the pending authorization: whoever holds it completes the exchange the moment the user
 * authorizes. So it is not "less sensitive than the token" — for the length of the flow it *is* a
 * token, and it stays in Electron main exactly like one. What the renderer receives is
 * `userCode`: an eight-character pairing code that is useless without the device code, exists to
 * be read aloud and typed into another surface, and is the one part of this flow a human is
 * supposed to see.
 *
 * There is correspondingly no field here for a token, a device code, or an authorization URL the
 * renderer could supply back. The renderer cannot even ask main to open an arbitrary verification
 * page: it asks main to open *the* verification page, and main uses the URL it validated itself.
 */
export const pipenzoDeviceCodeV1Schema = z.object({
  /** GitHub's user code, e.g. `ABCD-1234`. Displayed, copied, typed by a human. */
  userCode: z.string().min(1).max(64),
  /** Shown as text so the user can see where they are being sent before they click. */
  verificationUri: z.string().url(),
  /** Epoch milliseconds. The UI counts down against it; main enforces it. */
  expiresAt: z.number().int().positive(),
});

export type PipenzoDeviceCodeV1 = z.infer<typeof pipenzoDeviceCodeV1Schema>;

/**
 * Why a sign-in ended without a credential.
 *
 * A closed enum, because the UI says something genuinely different for each: `expired` and
 * `denied` are the user's to retry, `not_configured` is a build fault no amount of retrying fixes
 * (see #220), and `unreachable` is worth distinguishing from all of them so "your network is down"
 * is never reported as "GitHub rejected you". A free-text message would be pattern-matched here
 * within a release.
 */
export const pipenzoDeviceFailureReasonV1Schema = z.enum([
  'expired',
  'denied',
  'cancelled',
  'not_configured',
  'unreachable',
  /** The credential was obtained but this machine has no credential store to keep it in. */
  'storage_unavailable',
]);

export type PipenzoDeviceFailureReasonV1 = z.infer<typeof pipenzoDeviceFailureReasonV1Schema>;

/**
 * How a sign-in ended. Pushed to the renderer rather than returned, because the flow outlives the
 * call that starts it -- the human is in another application for most of it.
 *
 * Note what `connected` does *not* carry: the credential, the account, or anything about them. It
 * is a signal to re-read `pipenzoGitHubConnection()`, which is the one path that describes the
 * stored credential, and which already cannot carry a token.
 */
export const pipenzoDeviceOutcomeV1Schema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('connected') }),
  z.object({ state: z.literal('failed'), reason: pipenzoDeviceFailureReasonV1Schema }),
]);

export type PipenzoDeviceOutcomeV1 = z.infer<typeof pipenzoDeviceOutcomeV1Schema>;
