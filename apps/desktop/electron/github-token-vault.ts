import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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
 * Both are refused: `store()` throws `GitHubTokenVaultError` and writes nothing, so a user on such
 * a machine gets a clear "this machine has no OS credential store" instead of a file they believe
 * is safe. The second refusal depends on `getSelectedStorageBackend()`, which every Electron this
 * app builds against has; on a hypothetical Linux build whose Electron lacks the accessor entirely
 * the vault falls back to trusting `isEncryptionAvailable()`, which would say yes to `basic_text`.
 * See `encryptionAvailability()` for why that fallback is still the better answer than refusing
 * the whole platform.
 *
 * ## What is deliberately *not* encrypted
 *
 * The login and the timestamp. They are not secrets, and keeping them in cleartext lets
 * `status()` answer "connected as X" without decrypting anything — so the only code path that ever
 * produces plaintext is `readToken()`, which has exactly one caller (`main.ts`'s daemon spawn) and
 * a source-level test asserting it stays that way.
 *
 * ## Where the plaintext goes from here
 *
 * Down the daemon child's **stdin**, once, at spawn — never into its environment. The daemon is the
 * parent of every provider subprocess, and a child can read its parent's initial environment block
 * (`/proc/<ppid>/environ` on Linux, the PEB on Windows) no matter what it inherited, so an
 * environment variable would put the token one `cat` away from model-authored code. See
 * `daemon-environment.ts` and the daemon's `github-credential.ts`.
 *
 * ## What this does not defend against, stated rather than implied
 *
 * Anything already running as this OS user. `safeStorage` binds its key to that account, so a
 * process running as the user can decrypt the file — and `clear()` unlinks rather than scrubs, so
 * the ciphertext stays recoverable from free blocks. No file format fixes that. The real mitigation
 * is a credential that expires: a GitHub App installation token or an OAuth token with refresh,
 * rather than a long-lived `repo` PAT. That is a decision for the device-flow ticket (#114), and it
 * is recorded here so it is a choice rather than an oversight.
 *
 * ## What calls `store()`, and what still stands between it and a usable packaged build
 *
 * The device-code flow (#114) is the one caller: `device-flow-session.ts` stores here after main
 * has polled GitHub to completion and read back the account the token belongs to.
 *
 * That flow cannot run until Pipenzo's OAuth app is registered and its client id filled in
 * (`github-oauth-app.ts`, tracked as #220) — which is an action on a real GitHub account, not
 * something the code can do for itself. Until then a **packaged** build still has no way to obtain
 * a credential at all: `resolveDaemonGitHubToken` answers `{ token: undefined, source: 'none' }`
 * there and every GitHub call fails `token_missing`. That is the intended end state of #165 rather
 * than a regression — a packaged build silently inheriting the launching shell's PAT is exactly
 * what it set out to stop — but it does mean **#220 has to land before a packaged build is
 * useful**, and packaging is its own epic (#8). Development builds are unaffected: they still have
 * a fallback, read from a file rather than a shell variable since issue #212 (`dev-token-file.ts`).
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
   *
   * Typed as possibly answering `undefined` even though Electron's own declaration does not. This
   * is a hand-written shim over another process's API, not a contract this module can enforce, and
   * the code that reads it has to handle an unhelpful answer anyway (it is treated as
   * `plaintext_backend`, the same as an unrecognised name). Declaring the narrower `string` here
   * would only prevent a test from constructing the case the implementation deliberately defends
   * against.
   */
  getSelectedStorageBackend?(): string | undefined;
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
 * The Linux `safeStorage` backends that are real keyrings. Allowlisted rather than denylisting
 * `basic_text`, so a backend Electron adds later — or reports as `unknown` — is refused by default
 * instead of silently trusted. See `encryptionAvailability`.
 */
const REAL_LINUX_BACKENDS = new Set(['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6']);

/**
 * What may be stored as a token.
 *
 * The character rule is the load-bearing part, and it is about the *destination*, not about GitHub:
 * this value is written to the daemon over a newline-terminated stdin message (issue #165 — it is
 * deliberately *not* an environment variable any more), and it ends up as an HTTP `Authorization`
 * header. A value containing a newline would frame a second message or split a request; a NUL or
 * other separator would do the same to whatever consumes it next.
 * Printable, non-whitespace ASCII covers every token format GitHub has ever issued (`ghp_`,
 * `gho_`, `github_pat_`, and the 40-hex classic) and excludes every separator.
 */
const TOKEN_PATTERN = /^[\x21-\x7e]{20,512}$/;

function assertToken(token: string): void {
  if (!TOKEN_PATTERN.test(token)) {
    throw new GitHubTokenVaultError(
      'invalid_token',
      'a GitHub token must be 20-512 printable, non-whitespace characters',
    );
  }
}

/**
 * Exactly the timestamp shape the wire contract accepts, not merely one `Date.parse` will take.
 *
 * The looser check let a hand-edited `"storedAt": "2026-09-07"` read back as `connected` here and
 * then fail `pipenzoGitHubConnectionV1Schema.parse` in the preload — so the connection channel
 * would throw on every call, permanently, instead of degrading to `unreadable` and offering a
 * reconnect. This file is writable by anything running as this user, which is the whole reason it
 * is re-validated on the way in rather than trusted.
 */
function isIsoTimestamp(value: string): boolean {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

/** Constant-time, so verifying the round trip is not itself a timing oracle on the token. */
function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
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
      // An *absent* accessor (older Electron) is not a failure: refusing every Linux machine
      // because an introspection call does not exist would make the vault unusable on the platform,
      // which is a worse answer than trusting the `isEncryptionAvailable()` the platform does give.
      //
      // A backend the accessor reports but cannot name *is* a failure. `basic_text` is a published
      // constant key; `unknown` means Electron could not identify the backend at all, which is the
      // same epistemic state as the missing accessor except that here the accessor exists and is
      // telling us it does not know. A credential store that cannot say what it is, is not one to
      // claim protection from.
      //
      // Which is why presence is tested on the *function*, not on its return value. Reading the
      // answer through `?.()` collapses "there is no accessor" and "the accessor answered
      // `undefined`" — and a throwing accessor — into one `undefined`, and then the allowlist check
      // below skips all three. That takes the two cases this comment calls failures and gives them
      // the exemption written for the third. `REAL_LINUX_BACKENDS` is an allowlist precisely so an
      // unrecognised answer fails closed; an unrecognised answer includes no answer at all.
      const accessor = this.#safeStorage.getSelectedStorageBackend;
      if (typeof accessor === 'function') {
        let backend: string | undefined;
        try {
          backend = accessor.call(this.#safeStorage);
        } catch {
          backend = undefined;
        }
        if (!REAL_LINUX_BACKENDS.has(backend ?? '')) {
          return { available: false, reason: 'plaintext_backend' };
        }
      }
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
      const encrypted = this.#safeStorage.encryptString(input.token);
      // Verify the round trip before writing. Encryption succeeding does not mean decryption will:
      // on macOS the Keychain item's ACL is bound to the app's code signature, so a rename, a
      // re-sign, or an unsigned development build produces a record that stores fine and can never
      // be read back. Without this check the user would see "connected as X" — `status()` never
      // decrypts — while `readToken()` silently returned nothing and the daemon ran with no
      // credential at all.
      if (!sameSecret(this.#safeStorage.decryptString(encrypted), input.token)) {
        throw new Error('round trip mismatch');
      }
      ciphertext = encrypted.toString('base64');
    } catch {
      // Deliberately not re-thrown with the underlying message: an encryption failure's message is
      // one of the few places a library could echo its input back.
      throw new GitHubTokenVaultError(
        'write_failed',
        'the OS credential store could not store and read back the token',
      );
    }
    const record: StoredVaultRecord = {
      schemaVersion: GITHUB_TOKEN_VAULT_SCHEMA_VERSION,
      ciphertext,
      login: input.login,
      storedAt: new Date().toISOString(),
    };

    mkdirSync(this.#directory, { recursive: true, mode: 0o700 });
    // Sweep any temporary file a previous crash left behind before writing a new one. Each of those
    // holds a ciphertext copy, and nothing else would ever remove them.
    this.#sweepTemporaryFiles();
    const temporaryPath = `${this.#path}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      const handle = openSync(temporaryPath, 'wx', 0o600);
      try {
        // `writeFileSync` on the fd, not `writeSync`: a bare `writeSync` returns a byte count and
        // does not guarantee it wrote everything, so a short write would publish a truncated
        // record that reads back as `unreadable`.
        writeFileSync(handle, JSON.stringify(record), 'utf8');
        // Durability before the rename, not after: without it a crash can publish a zero-length
        // file over a perfectly good record, and the user's only symptom is having to reconnect.
        fsyncSync(handle);
      } finally {
        closeSync(handle);
      }
      // `open`'s mode is masked by umask and ignored where the file already exists; an explicit
      // chmod is what actually guarantees the mode on the platforms that have one. (On Windows it
      // only toggles the read-only bit — the real protection there is the user-profile ACL.)
      chmodSync(temporaryPath, 0o600);
      renameSync(temporaryPath, this.#path);
      this.#syncDirectory();
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

  /**
   * Forgets the stored token. Removing a vault that is not there is success, not a failure.
   *
   * Unlinking does not scrub the blocks, so the ciphertext stays recoverable from free space by
   * anyone who is already this OS user — and `safeStorage` binds its key to that same user, so they
   * could decrypt it. Overwriting the file first would not fix that either (a journalling or
   * copy-on-write filesystem writes elsewhere). The honest mitigation is not a better delete: it is
   * a credential that expires. That is a reason to move to a GitHub App installation token or an
   * OAuth token with refresh rather than a long-lived `repo` PAT, and it is recorded here rather
   * than papered over with a shred that does not shred.
   *
   * Returns whether a record was actually removed, which the caller needs and cannot get from
   * `status()`. `status()` answers availability before it looks for a record, so on a machine with
   * no usable OS credential store it reports `unavailable` whether or not a vault file exists —
   * meaning "did this call change anything?" is unanswerable from the status enum on exactly the
   * machines where it is asked most. `existsSync` before the unlink is the only honest answer.
   */
  clear(): boolean {
    const existed = existsSync(this.#path);
    // `finally`, because a throwing `rmSync` (EPERM/EBUSY — an antivirus or indexer holding the
    // handle open on the packaging platform) would otherwise skip the sweep on exactly the machines
    // where deletion is failing, and every unswept `.tmp` left by an interrupted write is a full
    // ciphertext copy of the credential the user just asked to forget.
    try {
      rmSync(this.#path, { force: true });
    } finally {
      this.#sweepTemporaryFiles();
    }
    return existed;
  }

  /**
   * Makes the rename itself durable.
   *
   * `fsync` on the file only guarantees its *contents*; the directory entry that publishes the new
   * name is a separate write, and without this a crash can leave the old record — or no record —
   * despite a successful `renameSync`. POSIX only: Windows cannot `open` a directory, and NTFS
   * journals the metadata anyway, so failing here is expected rather than a problem.
   */
  #syncDirectory(): void {
    let handle: number | undefined;
    try {
      handle = openSync(this.#directory, 'r');
      fsyncSync(handle);
    } catch {
      // Windows, or a filesystem that will not fsync a directory. Nothing to do and nothing lost.
    } finally {
      if (handle !== undefined) {
        try {
          closeSync(handle);
        } catch {
          // Already closed, or never really opened.
        }
      }
    }
  }

  /** Removes crashed-write leftovers. Each one holds a ciphertext copy nothing else would clean. */
  #sweepTemporaryFiles(): void {
    let names: string[];
    try {
      names = readdirSync(this.#directory);
    } catch {
      return;
    }
    const prefix = `${GITHUB_TOKEN_VAULT_FILE}.`;
    for (const name of names) {
      if (!name.startsWith(prefix) || !name.endsWith('.tmp')) continue;
      try {
        rmSync(join(this.#directory, name), { force: true });
      } catch {
        // A file another instance is mid-write on. It will be swept by whoever writes next.
      }
    }
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
    // attacker-writable by anyone who is already this OS user, and this value goes onto the
    // daemon's stdin as a newline-framed message and from there into an `Authorization` header.
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
      !isIsoTimestamp(record.storedAt)
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
