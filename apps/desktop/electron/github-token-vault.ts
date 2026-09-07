import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Pipenzo's GitHub token vault (issue #165).
 *
 * ## Where the credential lives, and why here
 *
 * Epic #4 states it in one line: "Token to the Electron-main token vault, **never** handed to a
 * provider subprocess." Electron main is the only process in this app that is neither a renderer
 * (which is sandboxed and must never see a credential — see `preload.ts`) nor a provider subprocess
 * (which runs model-authored code). So main holds it, and everything else is handed the *effects*
 * of holding it rather than the value.
 *
 * ## At rest: `safeStorage`, and what that actually buys
 *
 * Encryption is Electron's `safeStorage`, which wraps DPAPI on Windows, the Keychain on macOS, and
 * libsecret/kwallet on Linux behind one call. Chosen over a hand-rolled scheme for the reason that
 * matters most about credential storage: there is no key for this application to manage, lose,
 * ship, or accidentally derive from something guessable. The key belongs to the OS user account,
 * which is also the exact threat model a local desktop app can honestly claim — this protects the
 * token from another user on the machine and from anything that reads the file without being that
 * user, and it does not protect against code already running as the user.
 *
 * ## The two ways "encryption available" can be a lie, and what this does about them
 *
 * 1. `isEncryptionAvailable()` is simply false (no keyring installed, an unsupported session).
 * 2. **On Linux, it can be true while the backend is `basic_text`** — a fixed, hardcoded key that
 *    is public knowledge. Files written that way are obfuscated, not encrypted, and treating them
 *    as encrypted is precisely the "silently store plaintext" failure this ticket must not have.
 *
 * Both are refused. `store()` throws `GitHubTokenVaultError` and writes nothing; the connect flow
 * surfaces that rather than pretending the token was protected. A user on such a machine gets a
 * clear "this machine has no OS credential store" instead of a file they believe is safe.
 *
 * ## What is deliberately *not* encrypted
 *
 * The login and the timestamp. They are not secrets, and keeping them in cleartext lets
 * `status()` answer "connected as X" without decrypting anything — so the only code path that ever
 * produces plaintext is `readToken()`, which has exactly one caller (`main.ts`'s daemon-environment
 * builder) and a source-level test asserting it stays that way.
 */

/** The file name under the vault directory. Versioned so a future format change is a new name. */
export const GITHUB_TOKEN_VAULT_FILE = 'github-token-v1.json';

export const GITHUB_TOKEN_VAULT_SCHEMA_VERSION = 1 as const;

/**
 * The part of Electron's `safeStorage` this module uses, as an interface rather than an import.
 *
 * Two reasons, both real. It keeps `electron` out of this module's import graph so the vault is
 * testable in a plain Node/vitest process (the same discipline `os-notification.ts` follows), and
 * it makes the *exact* surface used visible: three calls, one of them optional and Linux-only.
 */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
  /**
   * Present on Linux from Electron 15 on, absent elsewhere. `'basic_text'` means the "encryption"
   * is a published constant key — see the module comment.
   */
  getSelectedStorageBackend?(): string;
}

export type GitHubTokenVaultUnavailableReason =
  /** The OS reported no credential store at all. */
  | 'os_encryption_unavailable'
  /** Linux, `basic_text` backend: a published key, which is not encryption. */
  | 'plaintext_backend'
  /** A stored record exists but cannot be read or decrypted (wrong user, corrupt file). */
  | 'unreadable';

/**
 * What the renderer is allowed to know. Note what is not in this union at any depth: the token.
 * There is no variant, no optional field, and no IPC channel that returns it.
 */
export type GitHubTokenVaultStatus =
  | { readonly state: 'connected'; readonly login: string; readonly storedAt: string }
  | { readonly state: 'disconnected' }
  | { readonly state: 'unavailable'; readonly reason: GitHubTokenVaultUnavailableReason };

export type GitHubTokenVaultErrorCode =
  | 'encryption_unavailable'
  | 'invalid_token'
  | 'invalid_login'
  | 'write_failed';

export class GitHubTokenVaultError extends Error {
  readonly code: GitHubTokenVaultErrorCode;

  constructor(code: GitHubTokenVaultErrorCode, message: string) {
    // No interpolation of the token, ever, in any branch: the message is a constant string chosen
    // by the caller. A vault error is exactly the kind of thing that gets pasted into a bug report.
    super(message);
    this.name = 'GitHubTokenVaultError';
    this.code = code;
  }
}

interface StoredVaultRecord {
  readonly schemaVersion: typeof GITHUB_TOKEN_VAULT_SCHEMA_VERSION;
  /** base64 of whatever `safeStorage.encryptString` produced. Opaque to this module. */
  readonly ciphertext: string;
  readonly login: string;
  readonly storedAt: string;
}

/**
 * A GitHub login, by GitHub's own rules. Validated because it is written to a file, read back, and
 * later shown in the UI — a value that round-trips through disk is a value that has to be checked
 * on the way back in, not just on the way out.
 */
const LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

/**
 * What may be stored as a token.
 *
 * The character rule is the load-bearing part, and it is about the *destination*, not about GitHub:
 * this value is handed to the daemon as an environment variable, and a value containing a newline
 * or a NUL is a value that can terminate or inject an entry in some environment representations.
 * Printable, non-whitespace ASCII covers every token format GitHub has ever issued (`ghp_`,
 * `gho_`, `github_pat_`, and the 40-hex classic) and excludes every separator.
 */
const TOKEN_PATTERN = /^[\x21-\x7e]{8,512}$/;

function assertToken(token: string): void {
  if (!TOKEN_PATTERN.test(token)) {
    throw new GitHubTokenVaultError(
      'invalid_token',
      'a GitHub token must be 8-512 printable, non-whitespace characters',
    );
  }
}

function assertLogin(login: string): void {
  if (!LOGIN_PATTERN.test(login)) {
    throw new GitHubTokenVaultError('invalid_login', 'not a usable GitHub login');
  }
}

export interface GitHubTokenVaultOptions {
  /** Usually `app.getPath('userData')`. The vault file is created directly under it. */
  readonly directory: string;
  readonly safeStorage: SafeStorageLike;
  /** Injected so the Linux-only backend check is testable off Linux. */
  readonly platform?: NodeJS.Platform;
}

export class GitHubTokenVault {
  readonly #directory: string;
  readonly #path: string;
  readonly #safeStorage: SafeStorageLike;
  readonly #platform: NodeJS.Platform;

  constructor(options: GitHubTokenVaultOptions) {
    this.#directory = options.directory;
    this.#path = join(options.directory, GITHUB_TOKEN_VAULT_FILE);
    this.#safeStorage = options.safeStorage;
    this.#platform = options.platform ?? process.platform;
  }

  /** The vault file's path. Exposed for diagnostics and for the tests; never for reading it. */
  get path(): string {
    return this.#path;
  }

  /**
   * Whether this machine can actually protect a credential — see the module comment for why
   * "available" and "encrypted" are not the same question on Linux.
   *
   * `isEncryptionAvailable()` is called defensively: it throws before Electron's `ready` event, and
   * a status query racing app startup must degrade to "not available yet" rather than crash main.
   */
  encryptionAvailability(): { available: true } | { available: false; reason: GitHubTokenVaultUnavailableReason } {
    let available: boolean;
    try {
      available = this.#safeStorage.isEncryptionAvailable();
    } catch {
      return { available: false, reason: 'os_encryption_unavailable' };
    }
    if (!available) return { available: false, reason: 'os_encryption_unavailable' };
    if (this.#platform === 'linux') {
      let backend: string | undefined;
      try {
        backend = this.#safeStorage.getSelectedStorageBackend?.();
      } catch {
        backend = undefined;
      }
      // Only `basic_text` is refused. An *absent* accessor (older Electron) is not treated as a
      // failure: refusing every Linux machine because the introspection call does not exist would
      // make the vault unusable on the platform, which is a worse answer than trusting the
      // `isEncryptionAvailable()` the platform does provide.
      if (backend === 'basic_text') return { available: false, reason: 'plaintext_backend' };
    }
    return { available: true };
  }

  /**
   * Encrypts and stores one token, replacing whatever was there.
   *
   * Written to a temporary file and renamed, both `0o600`, so a reader can never observe a
   * half-written record and a crash mid-write cannot leave the previous token half-overwritten. The
   * temporary name carries random bytes rather than a pid so two writes cannot collide on it.
   */
  store(input: { token: string; login: string }): GitHubTokenVaultStatus {
    const availability = this.encryptionAvailability();
    if (!availability.available) {
      throw new GitHubTokenVaultError(
        'encryption_unavailable',
        availability.reason === 'plaintext_backend'
          ? 'this machine has no real OS credential store (Electron selected its plaintext backend), so the token was not stored'
          : 'this machine has no OS credential store available, so the token was not stored',
      );
    }
    assertToken(input.token);
    assertLogin(input.login);

    let ciphertext: string;
    try {
      ciphertext = this.#safeStorage.encryptString(input.token).toString('base64');
    } catch {
      // Deliberately not re-thrown with the underlying message: an encryption failure's message is
      // one of the few places a library could echo its input back.
      throw new GitHubTokenVaultError('write_failed', 'the OS credential store refused to encrypt');
    }
    const record: StoredVaultRecord = {
      schemaVersion: GITHUB_TOKEN_VAULT_SCHEMA_VERSION,
      ciphertext,
      login: input.login,
      storedAt: new Date().toISOString(),
    };

    mkdirSync(this.#directory, { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.#path}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      writeFileSync(temporaryPath, JSON.stringify(record), { encoding: 'utf8', mode: 0o600 });
      // `writeFileSync`'s `mode` is only applied when it creates the file, and is masked by umask;
      // an explicit chmod is what actually guarantees the mode on every platform that has one.
      chmodSync(temporaryPath, 0o600);
      renameSync(temporaryPath, this.#path);
    } catch (error) {
      try {
        rmSync(temporaryPath, { force: true });
      } catch {
        // Nothing useful to do about a failed cleanup of a file that may not exist.
      }
      throw new GitHubTokenVaultError(
        'write_failed',
        `could not write the token vault: ${error instanceof Error ? error.name : 'unknown error'}`,
      );
    }
    return { state: 'connected', login: record.login, storedAt: record.storedAt };
  }

  /** Forgets the stored token. Removing a vault that is not there is success, not a failure. */
  clear(): void {
    rmSync(this.#path, { force: true });
  }

  /**
   * What the renderer may be told. Never decrypts: a status query must not be a way to make the
   * process produce plaintext, and everything this returns is stored in cleartext anyway.
   */
  status(): GitHubTokenVaultStatus {
    // Availability first, and ahead of whether anything is stored, because the two answers lead to
    // different screens. "Nothing stored yet" means show a Connect button; "this machine has no OS
    // credential store" means that button can only ever fail, and a UI told `disconnected` would
    // offer it anyway. It is also the right answer in the other direction: a record that exists on
    // a machine that can no longer decrypt it must not read as `connected`, or the user is sent
    // into a publish that fails with a confusing 401 instead of into reconnecting.
    const availability = this.encryptionAvailability();
    if (!availability.available) return { state: 'unavailable', reason: availability.reason };
    const record = this.#readRecord();
    if (record === 'absent') return { state: 'disconnected' };
    if (record === 'unreadable') return { state: 'unavailable', reason: 'unreadable' };
    return { state: 'connected', login: record.login, storedAt: record.storedAt };
  }

  /**
   * The one method that produces plaintext.
   *
   * **Main process only, and exactly one caller.** `main.ts` calls it while building the daemon's
   * environment and nowhere else; `apps/desktop/test/github-token-boundary.test.ts` asserts that at
   * the source level, so a second caller fails a test rather than passing review.
   *
   * Returns `undefined` rather than throwing when there is nothing to read or nothing that can
   * decrypt it: "no credential configured" is the ordinary first-run state, and the daemon already
   * has a typed `token_missing` answer for it.
   */
  readToken(): string | undefined {
    const record = this.#readRecord();
    if (record === 'absent' || record === 'unreadable') return undefined;
    if (!this.encryptionAvailability().available) return undefined;
    let token: string;
    try {
      token = this.#safeStorage.decryptString(Buffer.from(record.ciphertext, 'base64'));
    } catch {
      return undefined;
    }
    // A decrypted value that does not look like a token is not handed onward: the file is
    // attacker-writable by anyone who is already this OS user, and this value goes into an
    // environment variable.
    return TOKEN_PATTERN.test(token) ? token : undefined;
  }

  #readRecord(): StoredVaultRecord | 'absent' | 'unreadable' {
    if (!existsSync(this.#path)) return 'absent';
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.#path, 'utf8'));
    } catch {
      return 'unreadable';
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'unreadable';
    const record = parsed as Partial<StoredVaultRecord>;
    if (
      record.schemaVersion !== GITHUB_TOKEN_VAULT_SCHEMA_VERSION ||
      typeof record.ciphertext !== 'string' ||
      record.ciphertext === '' ||
      typeof record.login !== 'string' ||
      !LOGIN_PATTERN.test(record.login) ||
      typeof record.storedAt !== 'string' ||
      !Number.isFinite(Date.parse(record.storedAt))
    ) {
      return 'unreadable';
    }
    return {
      schemaVersion: GITHUB_TOKEN_VAULT_SCHEMA_VERSION,
      ciphertext: record.ciphertext,
      login: record.login,
      storedAt: record.storedAt,
    };
  }
}
