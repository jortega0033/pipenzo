import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { NONCE_PATTERN, type ParsedPublishNonce } from './publish-nonce-v1.js';

/**
 * The Node-only half of the publish-nonce wire contract (Pipenzo issue #182) -- the functions that
 * actually mint or verify a nonce. Kept out of `publish-nonce-v1.ts` and out of this package's main
 * barrel (`index.ts`) specifically so no path reachable from `apps/desktop`'s browser-built renderer
 * bundle ever imports `node:crypto`; see that file's own module comment for why. Only the daemon and
 * Electron main (both real Node processes) import this file, via
 * `@agent-dock/shared/publish-nonce-node-v1.js`.
 */

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
