import { z } from 'zod';

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
 * back to an inherited `PIPENZO_GITHUB_TOKEN` when the vault is empty (see `daemon-environment.ts`).
 * "You are publishing with a shell variable, not with the account shown here" has to be a *visible*
 * state — the rule against credential fallbacks is really a rule against **silent** precedence.
 *
 * Two honest limits on that, so this field is not mistaken for more than it is. It is not yet
 * rendered anywhere (#113 owns the pre-app shell that will show it), and it describes what Electron
 * main *sent*, not what the daemon resolved — a stdin handoff that failed would still be reported
 * here as `vault`. Closing that second gap means having the daemon report its own resolved source
 * back over the health channel.
 */
export const pipenzoCredentialSourceV1Schema = z.enum(['vault', 'environment', 'none']);

export type PipenzoCredentialSourceV1 = z.infer<typeof pipenzoCredentialSourceV1Schema>;

export const pipenzoGitHubConnectionV1Schema = z.object({
  state: z.enum(['connected', 'disconnected', 'unavailable']),
  /** Present only when `state` is `connected`. GitHub's own login rules. */
  login: z
    .string()
    .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/)
    .optional(),
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
