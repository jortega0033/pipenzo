import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * The publish-nonce wire contract (Pipenzo issue #182).
 *
 * ## The gap this closes
 *
 * `apps/daemon/src/publish-service.ts`'s own module comment already names it: agentdock's
 * discovery file writes `{port, token}` to a mode-0600 file under the OS temp directory, and
 * `TEMP`/`TMP`/`HOME` sit on the reviewed allowlist a session's environment can see. A file-read-
 * capable agent session could in principle locate and read that file, and with it the daemon's
 * bearer token — mode 0600 separates *users*, not the agent from the daemon that spawned it. No
 * agent session has a *tool* that calls the publish route and no *environment* that addresses the
 * daemon (see that module's own token-boundary tests), so this is a narrow, multi-step gap rather
 * than a live exploit path — but it is a real one, and the publish route is the one place on the
 * daemon's authenticated surface that can push a branch or open a pull request.
 *
 * The fix is a second factor the bearer token alone cannot satisfy: a short-lived, single-use
 * nonce, minted by Electron main **at the instant** a human clicks "Push branch" or "Push & open
 * PR" (`apps/desktop/electron/main.ts`'s `daemon:pipenzo-publish` handler — the one IPC channel
 * that click reaches, guarded by `isFromMainWindowFrame`), and required by the route in addition
 * to the bearer token. Even a session that somehow obtained the bearer token off disk still could
 * not mint a nonce that verifies, because the secret this module signs with never touches disk at
 * all: it travels the same stdin handoff issue #165 built for the GitHub credential
 * (`apps/daemon/src/github-credential.ts`), held only in Electron main's and the daemon's own
 * process memory for the run's lifetime.
 *
 * ## Why an HMAC rather than a server-minted, then client-fetched, token
 *
 * A "call `/publish-nonce`, get a token, then call `/publish`" design would still only require the
 * bearer token to complete both calls — exactly the credential this nonce exists to be a *second*
 * factor beyond. Minting locally, from a secret the bearer token's own leak path (the discovery
 * file) never carries, is what actually adds a factor rather than an extra round trip.
 *
 * ## Wire shape
 *
 * `${random}.${issuedAtMs base36}.${hmac-sha256 hex}`, sent as the `PIPENZO_PUBLISH_NONCE_HEADER`
 * request header (never in the JSON body `PublishService`/`pipenzoPublishRequestV1Schema` already
 * validate as the git-safety argv contract — a route-level auth factor belongs beside the bearer
 * `Authorization` header it supplements, not inside the body those two independently re-validate).
 */

/** The header the route reads it from, and the client attaches it to. Lower-case: Fastify and the
 * Fetch `Headers` object both normalize header names this way, so comparing against this constant
 * on either side never depends on how a caller happened to capitalize it. */
export const PIPENZO_PUBLISH_NONCE_HEADER = 'x-pipenzo-publish-nonce';

/**
 * How long a minted nonce stays acceptable. Generous relative to "mint it, then make the one HTTP
 * call that follows immediately after" (main's click handler does nothing else in between), and
 * narrow enough that a nonce observed in flight — the one channel that is not disk, and the one
 * this design does not claim to defend — is useless within half a minute.
 */
export const PUBLISH_NONCE_FRESHNESS_MS = 30_000;

const NONCE_PATTERN = /^[0-9a-f]{32}\.[0-9a-z]+\.[0-9a-f]{64}$/;

/** 32 random bytes, hex-encoded: the shape both `buildDaemonCredentialMessage` (the sender) and
 * `PublishNonceGate` (the reader) agree the secret must have before either will use it. */
export function isPublishNonceSecretShaped(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

/** A fresh secret for a new Electron main process to hand the daemon over stdin at spawn. */
export function generatePublishNonceSecret(): Buffer {
  return randomBytes(32);
}

function macFor(secret: Buffer, random: string, issuedAtMs: number): string {
  return createHmac('sha256', secret).update(`${random}.${issuedAtMs.toString(36)}`).digest('hex');
}

/**
 * Mints one nonce. Call this from inside the click handler itself, never ahead of time and never
 * cached — a nonce minted before the click is not "bound to that specific click," it is a
 * standing credential with the same shape as the bearer token this exists to supplement.
 */
export function mintPublishNonce(secret: Buffer, now: number = Date.now()): string {
  const random = randomBytes(16).toString('hex');
  return `${random}.${now.toString(36)}.${macFor(secret, random, now)}`;
}

export interface ParsedPublishNonce {
  readonly random: string;
  readonly issuedAtMs: number;
}

/**
 * Authenticates a nonce against `secret` and returns its parsed fields, or `undefined` for
 * anything malformed or forged. Deliberately stateless: freshness needs "now" and single-use needs
 * a store, and neither belongs in a function every caller (including a stateless unit test) needs
 * to be able to call without standing up either.
 */
export function verifyPublishNonceMac(secret: Buffer, nonce: string): ParsedPublishNonce | undefined {
  if (!NONCE_PATTERN.test(nonce)) return undefined;
  const [random, issuedAtRaw, mac] = nonce.split('.') as [string, string, string];
  const issuedAtMs = parseInt(issuedAtRaw, 36);
  if (!Number.isFinite(issuedAtMs)) return undefined;
  const expected = Buffer.from(macFor(secret, random, issuedAtMs), 'utf8');
  const actual = Buffer.from(mac, 'utf8');
  // Equal-length by construction (both are 64 hex characters per NONCE_PATTERN), but
  // timingSafeEqual throws on a length mismatch rather than returning false -- checked explicitly
  // so a future loosening of the pattern fails closed instead of throwing past this function.
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return undefined;
  return { random, issuedAtMs };
}
