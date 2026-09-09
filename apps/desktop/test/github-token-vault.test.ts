import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  GITHUB_TOKEN_VAULT_FILE,
  GitHubTokenVault,
  GitHubTokenVaultError,
  type SafeStorageLike,
} from '../electron/github-token-vault.js';

/**
 * Assembled at runtime so no literal in this file matches a real GitHub token pattern on disk —
 * the repository's `gitleaks` gate should never have to decide whether a fixture is a leak.
 */
const fakeToken = (suffix: string): string => `${'gh'}${'o'}_${suffix}`;
const TOKEN = fakeToken('deviceFlowTokenForTests1');

/**
 * A stand-in for Electron's `safeStorage`. The transform is deliberately not the identity: the
 * point of several assertions below is that the *plaintext is absent from the file*, and a fake
 * that "encrypted" by returning its input would make every one of them pass vacuously.
 */
function fakeSafeStorage(overrides: Partial<SafeStorageLike> = {}): SafeStorageLike {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plainText) => Buffer.from(`v1:${[...plainText].reverse().join('')}`, 'utf8'),
    decryptString: (encrypted) => {
      const text = encrypted.toString('utf8');
      if (!text.startsWith('v1:')) throw new Error('not a ciphertext this fake produced');
      return [...text.slice(3)].reverse().join('');
    },
    ...overrides,
  };
}

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'pipenzo-vault-'));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function vaultWith(
  safeStorage: SafeStorageLike = fakeSafeStorage(),
  platform: NodeJS.Platform = 'win32',
): GitHubTokenVault {
  return new GitHubTokenVault({ directory, safeStorage, platform });
}

describe('GitHubTokenVault', () => {
  it('round-trips a token through the OS credential store', () => {
    const vault = vaultWith();
    const status = vault.store({ token: TOKEN, login: 'jortega0033' });

    expect(status).toMatchObject({ state: 'connected', login: 'jortega0033' });
    expect(vault.readToken()).toBe(TOKEN);
  });

  /** The whole point of the ticket: what lands on disk must not be the credential. */
  it('never writes the token in cleartext', () => {
    vaultWith().store({ token: TOKEN, login: 'jortega0033' });
    const onDisk = readFileSync(join(directory, GITHUB_TOKEN_VAULT_FILE), 'utf8');
    expect(onDisk).not.toContain(TOKEN);
    // The parts that are *not* secret are readable, so `status()` never has to decrypt.
    expect(JSON.parse(onDisk)).toMatchObject({ schemaVersion: 1, login: 'jortega0033' });
  });

  it('writes the vault file owner-only', () => {
    vaultWith().store({ token: TOKEN, login: 'jortega0033' });
    const mode = statSync(join(directory, GITHUB_TOKEN_VAULT_FILE)).mode & 0o777;
    // Windows does not implement POSIX modes; asserting them there tests Node's emulation, not the
    // vault. Everywhere else, the file must not be group- or world-readable.
    if (process.platform !== 'win32') expect(mode).toBe(0o600);
    else expect(mode & 0o400).toBe(0o400);
  });

  it('reports disconnected before anything is stored, and after a clear', () => {
    const vault = vaultWith();
    expect(vault.status()).toEqual({ state: 'disconnected' });
    expect(vault.readToken()).toBeUndefined();

    vault.store({ token: TOKEN, login: 'jortega0033' });
    expect(vault.status().state).toBe('connected');

    vault.clear();
    expect(vault.status()).toEqual({ state: 'disconnected' });
    expect(vault.readToken()).toBeUndefined();
  });

  it('treats clearing an empty vault as success', () => {
    expect(() => vaultWith().clear()).not.toThrow();
  });

  /**
   * `clear()` reports whether it actually removed a record, and `main.ts`'s
   * `pipenzo:disconnect-github` handler restarts the daemon only when it did.
   *
   * That guard used to be keyed on `status().state !== 'disconnected'` instead, which is wrong in a
   * way no source-level assertion catches: `status()` resolves encryption availability *before* it
   * looks for a record, so on a machine with no usable OS credential store it answers `unavailable`
   * forever — no record present, none storable — and the guard is permanently true. The renderer
   * could then loop the disconnect channel and restart the daemon without bound, and that restart
   * path deliberately bypasses the bounded `sessions.cancelAll`, so every repetition kills in-flight
   * sessions uncancelled.
   *
   * Hence the second case below. It is the one that regressed, and it fails if the decision is ever
   * routed back through `status()`.
   */
  describe('reports whether a disconnect actually removed anything', () => {
    it('false when there was nothing stored, true when there was', () => {
      const vault = vaultWith();
      expect(vault.clear()).toBe(false);

      vault.store({ token: TOKEN, login: 'jortega0033' });
      expect(vault.clear()).toBe(true);
      // And clearing the same vault again is once more a no-op.
      expect(vault.clear()).toBe(false);
    });

    it('false on a machine whose credential store is unavailable, where status() cannot tell', () => {
      const unavailable = vaultWith(
        fakeSafeStorage({ isEncryptionAvailable: () => false }),
        'linux',
      );
      // The precondition that made the old guard wrong: status() never says `disconnected` here.
      expect(unavailable.status().state).toBe('unavailable');
      expect(unavailable.clear()).toBe(false);
      expect(unavailable.clear()).toBe(false);
    });
  });

  /**
   * A crash between the write and the rename leaves a temporary file holding a full ciphertext
   * copy, and nothing else in the app would ever remove it. Both `store()` and `clear()` sweep.
   */
  it('sweeps ciphertext left behind by a crashed write', () => {
    const stale = join(directory, `${GITHUB_TOKEN_VAULT_FILE}.deadbeefdeadbeef.tmp`);
    const unrelated = join(directory, 'something-else.json');
    writeFileSync(stale, 'a leftover ciphertext', 'utf8');
    writeFileSync(unrelated, 'not ours', 'utf8');

    vaultWith().store({ token: TOKEN, login: 'jortega0033' });

    expect(readdirSync(directory).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    // Only this vault's own leftovers, never a neighbour's file.
    expect(readdirSync(directory)).toContain('something-else.json');

    writeFileSync(stale, 'another leftover', 'utf8');
    vaultWith().clear();
    expect(readdirSync(directory).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('replaces a stored token rather than accumulating records', () => {
    const vault = vaultWith();
    vault.store({ token: TOKEN, login: 'jortega0033' });
    const replacement = fakeToken('secondTokenForTests00001');
    vault.store({ token: replacement, login: 'someone-else' });

    expect(vault.readToken()).toBe(replacement);
    expect(vault.status()).toMatchObject({ state: 'connected', login: 'someone-else' });
  });

  /**
   * The decision this ticket turns on. "No OS credential store" must produce a refusal and an empty
   * vault, never a file the user believes is protected.
   */
  describe('refuses to store when the OS cannot actually protect the token', () => {
    it('when safeStorage reports encryption unavailable', () => {
      const vault = vaultWith(fakeSafeStorage({ isEncryptionAvailable: () => false }));
      const error = catchError(() => vault.store({ token: TOKEN, login: 'jortega0033' }));

      expect(error).toBeInstanceOf(GitHubTokenVaultError);
      expect((error as GitHubTokenVaultError).code).toBe('encryption_unavailable');
      expect(vault.status()).toEqual({
        state: 'unavailable',
        reason: 'os_encryption_unavailable',
      });
      // Nothing was written. This is the assertion the ticket actually asks for.
      expect(() => readFileSync(join(directory, GITHUB_TOKEN_VAULT_FILE))).toThrow();
    });

    /**
     * Linux's `basic_text` backend "encrypts" with a published constant key. `isEncryptionAvailable()`
     * returns true for it, which is exactly the trap: a vault that trusted that answer would store a
     * trivially reversible file while telling the user it was protected.
     */
    it('when Electron selected its Linux plaintext backend', () => {
      const vault = vaultWith(
        fakeSafeStorage({ getSelectedStorageBackend: () => 'basic_text' }),
        'linux',
      );
      const error = catchError(() => vault.store({ token: TOKEN, login: 'jortega0033' }));

      expect((error as GitHubTokenVaultError).code).toBe('encryption_unavailable');
      expect(vault.status()).toEqual({ state: 'unavailable', reason: 'plaintext_backend' });
    });

    it('but accepts a real Linux keyring backend', () => {
      for (const backend of ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6']) {
        const vault = vaultWith(
          fakeSafeStorage({ getSelectedStorageBackend: () => backend }),
          'linux',
        );
        expect(vault.store({ token: TOKEN, login: 'jortega0033' }).state).toBe('connected');
        vault.clear();
      }
    });

    /**
     * The whole reason the check is an allowlist rather than a denylist on `basic_text`. `unknown`
     * means Electron could not identify the backend — an accessor that exists and is telling us it
     * does not know, which is not a credential store to claim protection from.
     */
    it('refuses a backend Electron cannot identify, and any name it does not vouch for', () => {
      for (const backend of ['unknown', 'basic_text', 'some_future_backend', '']) {
        const vault = vaultWith(
          fakeSafeStorage({ getSelectedStorageBackend: () => backend }),
          'linux',
        );
        expect(vault.status()).toEqual({ state: 'unavailable', reason: 'plaintext_backend' });
        expect(catchError(() => vault.store({ token: TOKEN, login: 'jortega0033' }))).toBeInstanceOf(
          GitHubTokenVaultError,
        );
      }
    });

    /**
     * The gap this test and the throwing one below it exist for: an accessor that is *present* but
     * answers `undefined` rather than a name. Reading it through `?.()` would collapse this into the
     * same `undefined` an *absent* accessor produces, and the absent case is deliberately exempt, so
     * presence has to be tested on the function, not inferred from its return value.
     */
    it('refuses a present backend accessor that answers undefined, unlike an absent one', () => {
      const vault = vaultWith(
        fakeSafeStorage({ getSelectedStorageBackend: () => undefined }),
        'linux',
      );
      expect(vault.status()).toEqual({ state: 'unavailable', reason: 'plaintext_backend' });
      expect(catchError(() => vault.store({ token: TOKEN, login: 'jortega0033' }))).toBeInstanceOf(
        GitHubTokenVaultError,
      );
    });

    /**
     * Issue #215: a *throwing* accessor is a different fact from one that answers a name this
     * allowlist does not recognise, and conflating the two used to report `plaintext_backend` for
     * both. `safeStorage`'s own introspection is documented as throwing before Electron's `ready`
     * event, so a status query racing app startup on Linux should say "cannot tell yet", not "this
     * machine's backend is plaintext" -- both still refuse to store, but the reason reported differs.
     */
    it('reports backend_unknown rather than plaintext_backend when the accessor throws', () => {
      const vault = vaultWith(
        fakeSafeStorage({
          getSelectedStorageBackend: () => {
            throw new Error('backend introspection failed');
          },
        }),
        'linux',
      );
      expect(vault.status()).toEqual({ state: 'unavailable', reason: 'backend_unknown' });
      const error = catchError(() => vault.store({ token: TOKEN, login: 'jortega0033' }));
      expect(error).toBeInstanceOf(GitHubTokenVaultError);
      expect((error as GitHubTokenVaultError).message).not.toBe(
        'this machine has no OS credential store available, so the token was not stored',
      );
      // Never stored, same as every other unavailable reason.
      expect(() => readFileSync(join(directory, GITHUB_TOKEN_VAULT_FILE))).toThrow();
    });

    /**
     * The macOS Keychain case the round-trip check exists for: encryption *succeeds* and decryption
     * returns something else, rather than throwing. Without the check the user would be told
     * "connected as X" — `status()` never decrypts — while the daemon ran with no credential.
     */
    it('refuses to store when the round trip comes back different rather than failing', () => {
      const vault = vaultWith(
        fakeSafeStorage({ decryptString: () => fakeToken('aDifferentValueEntirely1') }),
      );
      const error = catchError(() => vault.store({ token: TOKEN, login: 'jortega0033' }));

      expect((error as GitHubTokenVaultError).code).toBe('write_failed');
      expect((error as Error).message).not.toContain(TOKEN);
      expect(vault.status()).toEqual({ state: 'disconnected' });
      expect(() => readFileSync(join(directory, GITHUB_TOKEN_VAULT_FILE))).toThrow();
    });

    /**
     * Older Electron has no `getSelectedStorageBackend`. Refusing every Linux machine because an
     * introspection call is missing would make the vault unusable on the platform — a worse answer
     * than trusting the `isEncryptionAvailable()` the platform does provide.
     */
    it('and does not punish a Linux build whose Electron lacks the backend accessor', () => {
      const storage = fakeSafeStorage();
      delete (storage as { getSelectedStorageBackend?: unknown }).getSelectedStorageBackend;
      expect(
        new GitHubTokenVault({ directory, safeStorage: storage, platform: 'linux' }).store({
          token: TOKEN,
          login: 'jortega0033',
        }).state,
      ).toBe('connected');
    });

    /** `isEncryptionAvailable()` throws before Electron's `ready`. A status query must not crash main. */
    it('and degrades rather than throwing when safeStorage itself throws', () => {
      const vault = vaultWith(
        fakeSafeStorage({
          isEncryptionAvailable: () => {
            throw new Error('called before app.whenReady()');
          },
        }),
      );
      expect(vault.status()).toEqual({ state: 'unavailable', reason: 'os_encryption_unavailable' });
      expect(vault.readToken()).toBeUndefined();
    });
  });

  describe('validates what it is asked to store', () => {
    it('refuses a token containing a separator a shell or environment could act on', () => {
      const vault = vaultWith();
      for (const bad of [`${TOKEN}\nPATH=/evil`, `${TOKEN}\0`, `${TOKEN} extra`, '', '   ', 'short']) {
        const error = catchError(() => vault.store({ token: bad, login: 'jortega0033' }));
        expect((error as GitHubTokenVaultError).code).toBe('invalid_token');
      }
      expect(vault.status()).toEqual({ state: 'disconnected' });
    });

    it('refuses a login that is not a GitHub login', () => {
      const vault = vaultWith();
      for (const bad of ['not a login', '-leading-dash', '', 'a'.repeat(40)]) {
        const error = catchError(() => vault.store({ token: TOKEN, login: bad }));
        expect((error as GitHubTokenVaultError).code).toBe('invalid_login');
      }
    });

    /** A vault error is exactly the kind of thing that gets pasted into a bug report. */
    it('never puts the token in its own error message', () => {
      const vault = vaultWith(fakeSafeStorage({ isEncryptionAvailable: () => false }));
      const error = catchError(() => vault.store({ token: TOKEN, login: 'jortega0033' }));
      expect((error as Error).message).not.toContain(TOKEN);
    });
  });

  describe('a record it cannot trust', () => {
    const write = (contents: string): void => {
      writeFileSync(join(directory, GITHUB_TOKEN_VAULT_FILE), contents, 'utf8');
    };

    it('reports unreadable rather than connected for a corrupt file', () => {
      for (const contents of ['not json', '[]', '{}', '{"schemaVersion":1}']) {
        write(contents);
        expect(vaultWith().status()).toEqual({ state: 'unavailable', reason: 'unreadable' });
        expect(vaultWith().readToken()).toBeUndefined();
      }
    });

    /**
     * A record written by a future build. Reading it with this build's assumptions is how a
     * migration turns into a silent misinterpretation, so an unknown version is refused outright.
     */
    it('refuses a record from a newer schema version', () => {
      write(JSON.stringify({ schemaVersion: 2, ciphertext: 'x', login: 'a', storedAt: new Date().toISOString() }));
      expect(vaultWith().status()).toEqual({ state: 'unavailable', reason: 'unreadable' });
    });

    /**
     * The file is writable by anyone who is already this OS user, and its decrypted contents become
     * an environment variable. A value that does not look like a token is not handed onward.
     */
    /**
     * A `storedAt` this vault accepts but the wire contract does not would make
     * `pipenzo:github-connection` throw in the preload on every call, permanently, instead of
     * degrading to `unreadable` and offering a reconnect. The file is writable by anything running
     * as this user, so it is re-validated on the way in rather than trusted.
     */
    it('refuses a timestamp the connection contract would reject', () => {
      for (const storedAt of ['2026-09-07', 'yesterday', '2026-09-07T00:00:00', '']) {
        write(
          JSON.stringify({ schemaVersion: 1, ciphertext: 'v1:x', login: 'jortega0033', storedAt }),
        );
        expect(vaultWith().status()).toEqual({ state: 'unavailable', reason: 'unreadable' });
      }
      // And the one the vault itself writes round-trips, which is what makes the rule safe.
      const vault = vaultWith();
      vault.store({ token: TOKEN, login: 'jortega0033' });
      const status = vault.status();
      expect(status.state).toBe('connected');
      expect(new Date((status as { storedAt: string }).storedAt).toISOString()).toBe(
        (status as { storedAt: string }).storedAt,
      );
    });

    it('refuses a decrypted value that is not token-shaped', () => {
      const storage = fakeSafeStorage({ decryptString: () => 'has a space in it' });
      vaultWith().store({ token: TOKEN, login: 'jortega0033' });
      expect(vaultWith(storage).readToken()).toBeUndefined();
    });

    it('returns undefined rather than throwing when decryption fails', () => {
      vaultWith().store({ token: TOKEN, login: 'jortega0033' });
      const storage = fakeSafeStorage({
        decryptString: () => {
          throw new Error('wrong OS user');
        },
      });
      expect(vaultWith(storage).readToken()).toBeUndefined();
    });

    /**
     * A record that exists on a machine that can no longer decrypt it must not read as `connected`:
     * that would send the user into a publish that fails with a confusing 401 instead of into
     * reconnecting.
     */
    it('reports unavailable, not connected, when the machine lost its credential store', () => {
      vaultWith().store({ token: TOKEN, login: 'jortega0033' });
      const vault = vaultWith(fakeSafeStorage({ isEncryptionAvailable: () => false }));
      expect(vault.status()).toEqual({ state: 'unavailable', reason: 'os_encryption_unavailable' });
      expect(vault.readToken()).toBeUndefined();
    });
  });
});

function catchError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to throw');
}
