import { GitHubClientError, resolveGitHubToken } from './github-client.js';

/**
 * How the daemon receives its GitHub credential from Electron main (issue #165).
 *
 * ## Why not the environment, which is where it used to come from
 *
 * The daemon is the **parent** of every provider subprocess. On Linux any process can read its own
 * ancestors' initial environment with `cat /proc/<ppid>/environ`; on Windows a same-user process
 * can read another's environment block out of the PEB. So a token delivered in the daemon's
 * environment is a token a model-directed shell command can print — and the reviewed allowlists in
 * `provider-environment.ts` and `pipenzo-git.ts` do not help, because they prevent a child from
 * *inheriting* the variable, not from *reading* it out of its parent.
 *
 * That makes "the token never reaches a provider subprocess" (epic #4, issue #165) false in
 * exactly the way that matters, and it is not fixable by unsetting the variable after start:
 * `/proc/<pid>/environ` is the copy made at `exec` and `unsetenv` never touches it.
 *
 * So the credential arrives over **stdin**, once, at startup, and is held in a module-private
 * field. A pipe between two processes is not a third process's to read, and a heap value has no
 * well-known address the way an environment block does. It is not absolute — anything running as
 * this user could still attach a debugger — but on Linux the default `yama` policy already stops a
 * child from `ptrace`ing its parent, so the trivially-scriptable path is closed rather than merely
 * discouraged.
 *
 * ## The environment path still exists, and is still correct, for one caller
 *
 * A daemon started directly (`pnpm --filter @agent-dock/daemon dev`, the live-smoke harness, CI)
 * has no Electron main to hand it anything, and reads `PIPENZO_GITHUB_TOKEN` exactly as before.
 * That path carries the `/proc` exposure described above; it is a development and test path, run by
 * an operator who exported the variable themselves, and it is documented rather than hidden.
 * Electron main strips the variable from the daemon's environment entirely, so the two sources can
 * never both be live in the shipped app.
 */

/**
 * Tells the daemon a credential message is coming, so a daemon started any other way never reads
 * from a stdin it does not own. Not a secret, and deliberately not the credential itself.
 */
export const CREDENTIAL_ON_STDIN_ENV_KEY = 'PIPENZO_CREDENTIAL_ON_STDIN';

/** A credential message is one short JSON line. Anything larger is a bug or an attack. */
export const MAX_CREDENTIAL_MESSAGE_BYTES = 8 * 1024;

/**
 * How long to wait for it. Generous relative to "the parent writes one line immediately after
 * spawn", and bounded because a daemon that hangs forever waiting for a message that is never
 * coming is a worse failure than one that starts without a credential and reports `token_missing`.
 */
export const CREDENTIAL_READ_TIMEOUT_MS = 5_000;

/** The wire shape. One field today; a JSON envelope so a second one does not need a new channel. */
export interface DaemonCredentialMessageV1 {
  readonly githubToken?: string | undefined;
}

/**
 * The same shape rule the vault applies before storing: printable, non-whitespace, bounded.
 *
 * Re-checked on arrival rather than trusted from the sender. The value is about to be used as an
 * HTTP `Authorization` header, and a header value containing a newline is request splitting.
 */
const TOKEN_PATTERN = /^[\x21-\x7e]{8,512}$/;

export function isTokenShaped(value: unknown): value is string {
  return typeof value === 'string' && TOKEN_PATTERN.test(value);
}

/**
 * Parses one credential message. Never throws: a malformed message means "no credential", which is
 * an ordinary state the daemon already knows how to report, and turning it into a startup crash
 * would make a garbled pipe indistinguishable from a broken build.
 */
export function parseDaemonCredentialMessage(raw: string): DaemonCredentialMessageV1 {
  const trimmed = raw.trim();
  if (trimmed === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const token = (parsed as { githubToken?: unknown }).githubToken;
  return isTokenShaped(token) ? { githubToken: token } : {};
}

/**
 * Reads one credential message from a stream, bounded in both bytes and time.
 *
 * Resolves with whatever arrived rather than rejecting on a timeout or an overflow, for the reason
 * `parseDaemonCredentialMessage` does not throw: every failure here means "no credential", and the
 * daemon has a typed answer for that already.
 */
export function readCredentialMessage(
  stream: NodeJS.ReadableStream,
  options: { maxBytes?: number; timeoutMs?: number } = {},
): Promise<string> {
  const maxBytes = options.maxBytes ?? MAX_CREDENTIAL_MESSAGE_BYTES;
  const timeoutMs = options.timeoutMs ?? CREDENTIAL_READ_TIMEOUT_MS;
  return new Promise<string>((resolve) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stream.removeListener('data', onData);
      stream.removeListener('end', finish);
      stream.removeListener('error', finish);
      // Nothing else is ever sent on this stream, and a listening stdin keeps the event loop alive.
      stream.pause();
      resolve(Buffer.concat(chunks).toString('utf8'));
    };
    const onData = (chunk: Buffer | string): void => {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
      bytes += buffer.length;
      if (bytes > maxBytes) {
        // Keep nothing: a message this size is not one this protocol produced, and a truncated
        // prefix of it is not a credential either.
        chunks.length = 0;
        finish();
        return;
      }
      chunks.push(buffer);
      // A newline terminates the message, so the common case does not wait for the parent to close
      // the pipe — and a parent that keeps stdin open by mistake does not stall startup.
      if (buffer.includes(0x0a)) finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    // A pending timer must not be the reason a daemon cannot exit.
    timer.unref?.();
    stream.on('data', onData);
    stream.once('end', finish);
    stream.once('error', finish);
  });
}

/**
 * The daemon's one GitHub credential, and the only thing that knows where it came from.
 *
 * Held in a private field rather than written back into `process.env`: putting it back would undo
 * the entire point (see the module comment), and would also make it visible to anything in-process
 * that spreads the environment.
 */
export class DaemonGitHubCredential {
  readonly #injected: string | undefined;

  private constructor(injected: string | undefined) {
    this.#injected = injected;
  }

  /** No credential at all. Used by tests and by any caller assembling a daemon by hand. */
  static none(): DaemonGitHubCredential {
    return new DaemonGitHubCredential(undefined);
  }

  static withToken(token: string): DaemonGitHubCredential {
    return new DaemonGitHubCredential(isTokenShaped(token) ? token : undefined);
  }

  /**
   * Reads the startup message when the parent said one is coming, and otherwise touches nothing.
   *
   * The env check matters more than it looks: a daemon started from a terminal has an interactive
   * stdin that will never reach EOF, so an unconditional read would hang startup for the whole
   * timeout on the one path where a human is watching.
   */
  static async fromStartup(options: {
    stdin: NodeJS.ReadableStream;
    env?: Readonly<Record<string, string | undefined>>;
    maxBytes?: number;
    timeoutMs?: number;
  }): Promise<DaemonGitHubCredential> {
    const env = options.env ?? process.env;
    if (env[CREDENTIAL_ON_STDIN_ENV_KEY] !== '1') return DaemonGitHubCredential.none();
    const raw = await readCredentialMessage(options.stdin, {
      ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
    return new DaemonGitHubCredential(parseDaemonCredentialMessage(raw).githubToken);
  }

  /** Whether a credential arrived over the pipe. Says nothing about the environment fallback. */
  get injected(): boolean {
    return this.#injected !== undefined;
  }

  /**
   * The token, or `token_missing`.
   *
   * The injected credential wins: in the shipped app it is the only one, because Electron main
   * strips the environment variable from the daemon's environment before spawning it. The
   * environment is consulted only for a daemon nobody injected into — a direct `pnpm dev`, the
   * live-smoke harness, CI — where it is the only source there is.
   */
  resolve(env: Readonly<Record<string, string | undefined>> = process.env): string {
    if (this.#injected !== undefined) return this.#injected;
    return resolveGitHubToken(env);
  }

  /** `resolve()`, but answering `undefined` instead of throwing for "not configured". */
  tryResolve(env: Readonly<Record<string, string | undefined>> = process.env): string | undefined {
    try {
      return this.resolve(env);
    } catch (error) {
      if (error instanceof GitHubClientError && error.code === 'token_missing') return undefined;
      throw error;
    }
  }
}
