import { PUBLISH_NONCE_FRESHNESS_MS, isPublishNonceSecretShaped } from '@agent-dock/shared';
import { verifyPublishNonceMac } from '@agent-dock/shared/src/publish-nonce-node-v1.js';
import type { DaemonCredentialMessageV1 } from './github-credential.js';

/**
 * The daemon half of issue #182's second factor. See `@agent-dock/shared`'s `publish-nonce-v1.ts`
 * for the full threat model and wire shape; this class owns the two things that module deliberately
 * leaves stateless: where the secret comes from, and single-use.
 *
 * ## Where the secret comes from
 *
 * Over the same stdin handoff as the GitHub credential (issue #165) -- `publishNonceSecret` on
 * `DaemonCredentialMessageV1`, read once at startup alongside the token and never written to
 * `process.env`, a file, or a log. That is the property that actually matters: the bearer token's
 * one known leak path (`publish-service.ts`'s own module comment: a file-read-capable session
 * reading the discovery file off `TEMP`/`HOME`) does not carry this secret, so possessing the
 * token is not possessing a way to mint a nonce that verifies.
 *
 * A daemon nobody injected into -- `pnpm dev`, the live-smoke harness, CI -- falls back to
 * `PIPENZO_PUBLISH_NONCE_SECRET`, the same shape of narrow, named, documented exception
 * `DaemonGitHubCredential` makes for `PIPENZO_GITHUB_TOKEN`. A daemon with neither has `configured`
 * `false` and refuses every publish request, same as a `token_missing` publish with no credential
 * at all: the boundary's default is "cannot publish," not "publishes unless configured otherwise."
 */

export const PUBLISH_NONCE_SECRET_ENV_KEY = 'PIPENZO_PUBLISH_NONCE_SECRET';

export class PublishNonceGate {
  readonly #secret: Buffer | undefined;
  /** Spent nonces, keyed on their random half, valued on when they age out of the freshness
   * window and can be forgotten. Unbounded only in the sense that nothing ever evicts an entry
   * early -- `#sweep` below bounds it to "however many nonces were consumed in the last
   * `PUBLISH_NONCE_FRESHNESS_MS`," which for a human-paced action is never large. */
  readonly #consumed = new Map<string, number>();

  private constructor(secret: Buffer | undefined) {
    this.#secret = secret;
  }

  /** No secret at all. A gate that refuses every request -- the fail-closed default for a daemon
   * assembled by hand (most tests) or one that genuinely has nothing configured. */
  static none(): PublishNonceGate {
    return new PublishNonceGate(undefined);
  }

  static withSecretHex(hex: string): PublishNonceGate {
    return new PublishNonceGate(isPublishNonceSecretShaped(hex) ? Buffer.from(hex, 'hex') : undefined);
  }

  /**
   * Built from the same parsed startup message `DaemonGitHubCredential.fromMessage` reads
   * (`readDaemonStartupMessage`, called once in `index.ts` -- stdin is a single stream). Falls
   * back to `PIPENZO_PUBLISH_NONCE_SECRET` only when nothing arrived over the pipe, the same
   * env-fallback shape `DaemonGitHubCredential` applies to its own token.
   */
  static fromMessage(
    message: DaemonCredentialMessageV1,
    env: Readonly<Record<string, string | undefined>> = process.env,
  ): PublishNonceGate {
    if (isPublishNonceSecretShaped(message.publishNonceSecret)) {
      return PublishNonceGate.withSecretHex(message.publishNonceSecret);
    }
    const fromEnv = env[PUBLISH_NONCE_SECRET_ENV_KEY];
    if (isPublishNonceSecretShaped(fromEnv)) return PublishNonceGate.withSecretHex(fromEnv);
    return PublishNonceGate.none();
  }

  /** Whether this gate can accept anything at all. Reported over `/health` the same shape
   * `githubCredentialSource` is, not exposed here -- callers that need the boundary enforced just
   * call `consume`, which already refuses everything when this is `false`. */
  get configured(): boolean {
    return this.#secret !== undefined;
  }

  /**
   * The secret this gate holds, hex-encoded, or `undefined` when unconfigured. Exists for exactly
   * one caller: `index.ts`, to register it with `github-client.ts`'s `registerKnownSecret` --
   * issue #211's mitigation, applied here the same way it already is to the resolved GitHub token
   * -- so `redactSecrets` scrubs this value by exact match should it ever end up in a log or error
   * string despite never being logged directly today. Not a general read accessor: nothing else in
   * this codebase has a reason to call it, and `consume` above never needs to.
   */
  secretHexForRedaction(): string | undefined {
    return this.#secret?.toString('hex');
  }

  /**
   * Authenticates, checks freshness, and burns a nonce in one atomic step. Never split into a
   * separate `verify()` a caller could check without consuming -- "check, then use" is exactly the
   * TOCTOU shape a single-use token exists to close, and Fastify's request handling is single-
   * threaded per request but this route has no other guard against two concurrent requests racing
   * the same nonce through a check-then-use gap.
   */
  consume(nonce: string | undefined, now: number = Date.now()): boolean {
    this.#sweep(now);
    if (this.#secret === undefined || typeof nonce !== 'string') return false;
    const parsed = verifyPublishNonceMac(this.#secret, nonce);
    if (!parsed) return false;
    // Symmetric, not "not yet expired": a nonce claiming to be from the future is exactly as
    // suspicious as a stale one, and there is no legitimate way for main's mint to run ahead of
    // the daemon's own clock by more than ordinary scheduling jitter.
    if (Math.abs(now - parsed.issuedAtMs) > PUBLISH_NONCE_FRESHNESS_MS) return false;
    if (this.#consumed.has(parsed.random)) return false;
    this.#consumed.set(parsed.random, parsed.issuedAtMs + PUBLISH_NONCE_FRESHNESS_MS);
    return true;
  }

  /** Forgets spent nonces once they have aged past the freshness window anyway -- at that point a
   * replay of the same value would already fail the freshness check on its own, so keeping the
   * entry buys nothing and only grows the map for a daemon that stays up a long time. */
  #sweep(now: number): void {
    for (const [random, expiresAt] of this.#consumed) {
      if (expiresAt <= now) this.#consumed.delete(random);
    }
  }
}
