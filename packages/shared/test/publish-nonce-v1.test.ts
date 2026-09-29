import { describe, expect, it } from 'vitest';
import {
  generatePublishNonceSecret,
  isPublishNonceSecretShaped,
  mintPublishNonce,
  verifyPublishNonceMac,
} from '../src/publish-nonce-v1.js';

const secretHex = (fill: string): Buffer => Buffer.from(fill.repeat(64).slice(0, 64), 'hex');

describe('mintPublishNonce / verifyPublishNonceMac', () => {
  it('round-trips a nonce minted for the secret that verifies it', () => {
    const secret = generatePublishNonceSecret();
    const now = 1_700_000_000_000;
    const nonce = mintPublishNonce(secret, now);
    expect(verifyPublishNonceMac(secret, nonce)).toEqual({
      random: expect.any(String),
      issuedAtMs: now,
    });
  });

  it('mints a different nonce on every call, even at the same instant', () => {
    const secret = generatePublishNonceSecret();
    const now = 1_700_000_000_000;
    expect(mintPublishNonce(secret, now)).not.toBe(mintPublishNonce(secret, now));
  });

  it('rejects a nonce minted for a different secret', () => {
    const nonce = mintPublishNonce(secretHex('a'), 1_700_000_000_000);
    expect(verifyPublishNonceMac(secretHex('b'), nonce)).toBeUndefined();
  });

  /** The property the whole design rests on: possessing the bearer token is not possessing this. */
  it('rejects a nonce with a tampered mac', () => {
    const secret = secretHex('a');
    const nonce = mintPublishNonce(secret, 1_700_000_000_000);
    const [random, issuedAt, mac] = nonce.split('.');
    const flippedLastChar = mac.slice(0, -1) + (mac.endsWith('0') ? '1' : '0');
    expect(verifyPublishNonceMac(secret, `${random}.${issuedAt}.${flippedLastChar}`)).toBeUndefined();
  });

  it('rejects a tampered issuedAt even when the random half is untouched', () => {
    const secret = secretHex('a');
    const nonce = mintPublishNonce(secret, 1_700_000_000_000);
    const [random, , mac] = nonce.split('.');
    expect(verifyPublishNonceMac(secret, `${random}.${(1_700_000_001_000).toString(36)}.${mac}`)).toBeUndefined();
  });

  it('rejects anything that is not the three-part shape', () => {
    const secret = generatePublishNonceSecret();
    for (const malformed of ['', 'not-a-nonce', 'a.b', 'a.b.c.d', `${'g'.repeat(32)}.1.${'0'.repeat(64)}`]) {
      expect(verifyPublishNonceMac(secret, malformed)).toBeUndefined();
    }
  });
});

describe('isPublishNonceSecretShaped', () => {
  it('accepts exactly 64 lowercase hex characters', () => {
    expect(isPublishNonceSecretShaped(generatePublishNonceSecret().toString('hex'))).toBe(true);
  });

  it('rejects anything shorter, longer, uppercase, or non-string', () => {
    expect(isPublishNonceSecretShaped('ab'.repeat(31))).toBe(false);
    expect(isPublishNonceSecretShaped('ab'.repeat(33))).toBe(false);
    expect(isPublishNonceSecretShaped('AB'.repeat(32))).toBe(false);
    expect(isPublishNonceSecretShaped(undefined)).toBe(false);
    expect(isPublishNonceSecretShaped(12345)).toBe(false);
  });
});
