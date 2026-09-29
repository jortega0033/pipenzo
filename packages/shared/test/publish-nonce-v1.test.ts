import { describe, expect, it } from 'vitest';
import { isPublishNonceSecretShaped } from '../src/publish-nonce-v1.js';
import { generatePublishNonceSecret } from '../src/publish-nonce-node-v1.js';

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
