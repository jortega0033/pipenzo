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
