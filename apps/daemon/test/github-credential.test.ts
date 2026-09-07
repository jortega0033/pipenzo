import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  CREDENTIAL_ON_STDIN_ENV_KEY,
  DaemonGitHubCredential,
  isTokenShaped,
  parseDaemonCredentialMessage,
  readCredentialMessage,
} from '../src/github-credential.js';
import { GitHubClientError } from '../src/github-client.js';

/**
 * Assembled at runtime so no literal here matches a real GitHub token pattern on disk — the
 * repository's `gitleaks` gate should never have to decide whether a fixture is a leak.
 */
const fakeToken = (suffix: string): string => `${'gh'}${'o'}_${suffix}`;
const TOKEN = fakeToken('injectedOverStdinForTest1');

const streamOf = (...chunks: string[]): NodeJS.ReadableStream =>
  Readable.from(chunks.map((chunk) => Buffer.from(chunk, 'utf8')));

/** A stream that never ends and never emits, standing in for an interactive stdin. */
function silentStream(): NodeJS.ReadableStream {
  return new Readable({ read() {} });
}

describe('parseDaemonCredentialMessage', () => {
  it('reads the token out of a well-formed message', () => {
    expect(parseDaemonCredentialMessage(`{"githubToken":"${TOKEN}"}\n`)).toEqual({
      githubToken: TOKEN,
    });
  });

  /**
   * Never throws. Every failure here means "no credential", which the daemon already reports as
   * `token_missing`; turning it into a startup crash would make a garbled pipe indistinguishable
   * from a broken build.
   */
  it('answers "no credential" for anything it cannot trust', () => {
    for (const raw of [
      '',
      '   \n',
      'not json',
      '[]',
      'null',
      '"a string"',
      '{}',
      '{"githubToken":null}',
      '{"githubToken":42}',
      `{"githubToken":"${TOKEN} with a space"}`,
      `{"githubToken":"${TOKEN}\\nPATH=/evil"}`,
      '{"githubToken":"short"}',
    ]) {
      expect(parseDaemonCredentialMessage(raw)).toEqual({});
    }
  });

  /** The value becomes an `Authorization` header, where a newline is request splitting. */
  it('enforces the same shape rule the vault applies on the way in', () => {
    expect(isTokenShaped(TOKEN)).toBe(true);
    for (const bad of ['short', 'has space', 'has\nnewline', 'has\ttab', '', 'x'.repeat(513)]) {
      expect(isTokenShaped(bad)).toBe(false);
    }
  });
});

describe('readCredentialMessage', () => {
  it('reads a newline-terminated message without waiting for the pipe to close', async () => {
    await expect(readCredentialMessage(streamOf(`{"githubToken":"${TOKEN}"}\n`))).resolves.toContain(
      TOKEN,
    );
  });

  it('reads a message that arrives in pieces', async () => {
    const raw = await readCredentialMessage(streamOf('{"githubT', `oken":"${TOKEN}"}`, '\n'));
    expect(parseDaemonCredentialMessage(raw)).toEqual({ githubToken: TOKEN });
  });

  it('reads a message the sender ended without a newline', async () => {
    const raw = await readCredentialMessage(streamOf(`{"githubToken":"${TOKEN}"}`));
    expect(parseDaemonCredentialMessage(raw)).toEqual({ githubToken: TOKEN });
  });

  /**
   * Resolving rather than rejecting on a timeout: "no credential" is a state the daemon already
   * knows how to report, and a daemon that hangs forever waiting for a message nobody is sending is
   * a worse failure than one that starts without a token.
   */
  it('gives up after its timeout rather than hanging startup', async () => {
    const started = Date.now();
    await expect(readCredentialMessage(silentStream(), { timeoutMs: 25 })).resolves.toBe('');
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  /** A prefix of an over-long message is not a credential either, so nothing is kept. */
  it('discards a message larger than its bound', async () => {
    const raw = await readCredentialMessage(streamOf('x'.repeat(200)), { maxBytes: 64 });
    expect(raw).toBe('');
  });
});

describe('DaemonGitHubCredential', () => {
  it('does not touch stdin unless the parent said a message is coming', async () => {
    // A daemon started from a terminal has an interactive stdin that never reaches EOF. An
    // unconditional read would stall startup for the whole timeout on the one path a human watches.
    const credential = await DaemonGitHubCredential.fromStartup({
      stdin: silentStream(),
      env: {},
      timeoutMs: 50_000,
    });
    expect(credential.injected).toBe(false);
  });

  it('takes the injected credential when the marker is set', async () => {
    const credential = await DaemonGitHubCredential.fromStartup({
      stdin: streamOf(`{"githubToken":"${TOKEN}"}\n`),
      env: { [CREDENTIAL_ON_STDIN_ENV_KEY]: '1' },
    });
    expect(credential.injected).toBe(true);
    expect(credential.resolve({})).toBe(TOKEN);
  });

  it('prefers the injected credential over any environment variable', async () => {
    const credential = await DaemonGitHubCredential.fromStartup({
      stdin: streamOf(`{"githubToken":"${TOKEN}"}\n`),
      env: { [CREDENTIAL_ON_STDIN_ENV_KEY]: '1' },
    });
    expect(credential.resolve({ PIPENZO_GITHUB_TOKEN: fakeToken('fromTheShell000000000001') })).toBe(
      TOKEN,
    );
  });

  /**
   * The path a daemon started directly takes — `pnpm --filter @agent-dock/daemon dev`, the
   * live-smoke harness, CI. Electron main strips the variable from the daemon's environment
   * entirely, so the two sources can never both be live in the shipped app.
   */
  it('falls back to the environment when nothing was injected', () => {
    const token = fakeToken('fromTheShell000000000001');
    expect(DaemonGitHubCredential.none().resolve({ PIPENZO_GITHUB_TOKEN: token })).toBe(token);
  });

  it('reports token_missing when there is neither', () => {
    let caught: unknown;
    try {
      DaemonGitHubCredential.none().resolve({});
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(GitHubClientError);
    expect((caught as GitHubClientError).code).toBe('token_missing');
    expect(DaemonGitHubCredential.none().tryResolve({})).toBeUndefined();
  });

  it('refuses an injected value that is not token-shaped', async () => {
    const credential = await DaemonGitHubCredential.fromStartup({
      stdin: streamOf('{"githubToken":"has a space in it"}\n'),
      env: { [CREDENTIAL_ON_STDIN_ENV_KEY]: '1' },
    });
    expect(credential.injected).toBe(false);
    expect(credential.tryResolve({})).toBeUndefined();
  });

  it('refuses one handed in directly, too', () => {
    expect(DaemonGitHubCredential.withToken('short').injected).toBe(false);
    expect(DaemonGitHubCredential.withToken(TOKEN).resolve({})).toBe(TOKEN);
  });
});

/**
 * The one property none of the tests above can reach.
 *
 * Every case so far feeds a `Readable.from(...)` or a hand-rolled stream, which is a JavaScript
 * object — it never exercises the reader against a real libuv pipe handle, and that is exactly
 * where the only real hazard lives: a stdin the event loop is still watching keeps the process
 * alive, and `pause()` alone does not release it on Windows. A unit test cannot observe that. A
 * child process either exits or it does not.
 */
describe('over a real pipe, which is the only thing that proves the handoff', () => {
  // A `file:` URL, not a path: `import()` of a bare `D:\…` is `ERR_UNSUPPORTED_ESM_URL_SCHEME`.
  const READER = `
    const { DaemonGitHubCredential } = await import(${JSON.stringify(
      new URL('../src/github-credential.ts', import.meta.url).href,
    )});
    const credential = await DaemonGitHubCredential.fromStartup({ stdin: process.stdin });
    process.stdout.write(JSON.stringify({ injected: credential.injected, token: credential.tryResolve({}) }));
  `;

  function runReader(
    write: (stdin: NodeJS.WritableStream) => void,
    env: Record<string, string>,
  ): Promise<{ stdout: string; exited: boolean }> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', READER], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...env },
        windowsHide: true,
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
      // The point of the test: the child must exit on its own once it has read the message. A
      // reader that leaves stdin watched would sit here until this timer fires.
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve({ stdout, exited: false });
      }, 20_000);
      child.on('error', reject);
      child.on('exit', (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          reject(new Error(`reader exited ${String(code)}: ${stderr.slice(0, 2_000)}`));
          return;
        }
        resolve({ stdout, exited: true });
      });
      write(child.stdin);
    });
  }

  it('receives the token and then lets the process exit', async () => {
    const result = await runReader(
      (stdin) => stdin.end(`${JSON.stringify({ githubToken: TOKEN })}\n`, 'utf8'),
      { PIPENZO_CREDENTIAL_ON_STDIN: '1' },
    );
    expect(result.exited).toBe(true);
    expect(JSON.parse(result.stdout)).toEqual({ injected: true, token: TOKEN });
  }, 30_000);

  /**
   * The harder half: the parent writes the line but leaves the pipe **open**. The reader settles on
   * the newline rather than on EOF, and must then release the handle so the process can still exit.
   * With `pause()` alone and no `unref()`, this hangs.
   */
  it('exits even when the writer never closes the pipe', async () => {
    const result = await runReader(
      (stdin) => stdin.write(`${JSON.stringify({ githubToken: TOKEN })}\n`, 'utf8'),
      { PIPENZO_CREDENTIAL_ON_STDIN: '1' },
    );
    expect(result.exited).toBe(true);
    expect(JSON.parse(result.stdout)).toEqual({ injected: true, token: TOKEN });
  }, 30_000);

  /** And without the marker it must not read, or touch, a stdin it does not own. */
  it('ignores an open stdin entirely when the marker is absent', async () => {
    const result = await runReader(() => {}, { PIPENZO_CREDENTIAL_ON_STDIN: '' });
    expect(result.exited).toBe(true);
    expect(JSON.parse(result.stdout)).toEqual({ injected: false });
  }, 30_000);
});
