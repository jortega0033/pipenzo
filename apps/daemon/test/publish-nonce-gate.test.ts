import { describe, expect, it } from 'vitest';
import { generatePublishNonceSecret, mintPublishNonce } from '@agent-dock/shared/src/publish-nonce-node-v1.js';
import { PUBLISH_NONCE_SECRET_ENV_KEY, PublishNonceGate } from '../src/publish-nonce-gate.js';
import type { DaemonCredentialMessageV1 } from '../src/github-credential.js';

const hex = (secret: Buffer): string => secret.toString('hex');

describe('PublishNonceGate', () => {
  it('is unconfigured, and refuses everything, with no secret at all', () => {
    const gate = PublishNonceGate.none();
    expect(gate.configured).toBe(false);
    expect(gate.consume(mintPublishNonce(generatePublishNonceSecret()))).toBe(false);
    expect(gate.consume(undefined)).toBe(false);
  });

  it('accepts a fresh nonce minted for its own secret, exactly once', () => {
    const secret = generatePublishNonceSecret();
    const gate = PublishNonceGate.withSecretHex(hex(secret));
    const nonce = mintPublishNonce(secret);
    expect(gate.consume(nonce)).toBe(true);
    // The single-use property: a second presentation of the same nonce is a replay.
    expect(gate.consume(nonce)).toBe(false);
  });

  it('rejects a nonce minted for a different secret', () => {
    const gate = PublishNonceGate.withSecretHex(hex(generatePublishNonceSecret()));
    expect(gate.consume(mintPublishNonce(generatePublishNonceSecret()))).toBe(false);
  });

  it('rejects a nonce outside the freshness window, in either direction', () => {
    const secret = generatePublishNonceSecret();
    const gate = PublishNonceGate.withSecretHex(hex(secret));
    const now = 1_700_000_000_000;
    expect(gate.consume(mintPublishNonce(secret, now - 60_000), now)).toBe(false);
    expect(gate.consume(mintPublishNonce(secret, now + 60_000), now)).toBe(false);
  });

  it('accepts a nonce right at the edge of the freshness window', () => {
    const secret = generatePublishNonceSecret();
    const gate = PublishNonceGate.withSecretHex(hex(secret));
    const now = 1_700_000_000_000;
    expect(gate.consume(mintPublishNonce(secret, now - 29_000), now)).toBe(true);
  });

  it('ignores a secret that is not 64 lowercase hex characters', () => {
    expect(PublishNonceGate.withSecretHex('too-short').configured).toBe(false);
    expect(PublishNonceGate.withSecretHex('AB'.repeat(32)).configured).toBe(false);
  });

  /** Issue #182's security-review nit: `index.ts` registers this with `registerKnownSecret` the
   * same way it registers the resolved GitHub token. */
  describe('secretHexForRedaction', () => {
    it('reports the configured secret, hex-encoded', () => {
      const secret = generatePublishNonceSecret();
      expect(PublishNonceGate.withSecretHex(hex(secret)).secretHexForRedaction()).toBe(hex(secret));
    });

    it('reports undefined when unconfigured, so there is nothing to register', () => {
      expect(PublishNonceGate.none().secretHexForRedaction()).toBeUndefined();
    });
  });

  describe('fromMessage', () => {
    it('prefers the secret carried on the startup message over the environment', () => {
      const injected = generatePublishNonceSecret();
      const fromEnv = generatePublishNonceSecret();
      const message: DaemonCredentialMessageV1 = { publishNonceSecret: hex(injected) };
      const gate = PublishNonceGate.fromMessage(message, {
        [PUBLISH_NONCE_SECRET_ENV_KEY]: hex(fromEnv),
      });
      expect(gate.consume(mintPublishNonce(injected))).toBe(true);
      expect(gate.consume(mintPublishNonce(fromEnv))).toBe(false);
    });

    /** The narrow, named exception for a daemon nobody injected into -- `pnpm dev`, the live-smoke
     * harness, CI -- the same shape `DaemonGitHubCredential` applies to its own token. */
    it('falls back to PIPENZO_PUBLISH_NONCE_SECRET when nothing was injected', () => {
      const fromEnv = generatePublishNonceSecret();
      const gate = PublishNonceGate.fromMessage({}, { [PUBLISH_NONCE_SECRET_ENV_KEY]: hex(fromEnv) });
      expect(gate.configured).toBe(true);
      expect(gate.consume(mintPublishNonce(fromEnv))).toBe(true);
    });

    it('is unconfigured when neither the message nor the environment carries one', () => {
      expect(PublishNonceGate.fromMessage({}, {}).configured).toBe(false);
    });
  });
});
