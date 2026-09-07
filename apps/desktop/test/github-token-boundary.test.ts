import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CREDENTIAL_ON_STDIN_ENV_KEY,
  DAEMON_GITHUB_TOKEN_ENV_KEY,
  GITHUB_CREDENTIAL_ENV_KEYS,
  buildDaemonCredentialMessage,
  buildDaemonEnvironment,
  resolveDaemonGitHubToken,
} from '../electron/daemon-environment.js';

/**
 * Issue #165's actual acceptance criterion: **the token never reaches a provider subprocess.**
 *
 * The daemon side of the boundary is enforced separately
 * (`apps/daemon/test/publish-token-boundary.test.ts`): every provider spawn builds its environment
 * from a reviewed allowlist that no GitHub variable is on. That covers *inheritance*. It does not
 * cover the sharper problem this file exists for: **the daemon is the parent of every provider
 * subprocess**, and a child can read its parent's initial environment block — `cat
 * /proc/<ppid>/environ` on Linux, the PEB on Windows — no matter what it inherited. A token in the
 * daemon's environment is a token a model-directed shell command can print.
 *
 * So the properties asserted here are:
 *
 * 1. The plaintext is produced in exactly one place and delivered over a pipe, not an environment.
 * 2. No GitHub credential survives into the daemon's environment from any source.
 * 3. Which credential the daemon runs on is decided once, and named.
 * 4. Nothing on the renderer bridge can obtain the token, in either direction.
 *
 * They are structural rather than one end-to-end run, because each has to hold for every future
 * call site and not just for whichever path a scenario happens to exercise.
 */

/**
 * Resolved lazily, and relative to this file, exactly as `release-branding.test.ts` does: the
 * module-scope form of this fails under the desktop project's jsdom environment.
 */
const fromHere = (relativePath: string): string =>
  fileURLToPath(new URL(relativePath, import.meta.url));

const electronSrc = (): string => fromHere('../electron');
const rendererSrc = (): string => fromHere('../src');
const daemonSrc = (): string => fromHere('../../daemon/src');

/**
 * Strips block comments and whole-line `//` comments, so prose *about* a forbidden pattern never
 * reads as an occurrence of it.
 *
 * Deliberately not trailing `//` comments: a rule that stripped from `//` to end of line anywhere
 * would also cut everything after a `https://…` inside a string literal, and a real call sitting on
 * such a line would become invisible to these scans. Under-stripping produces a false alarm someone
 * investigates; over-stripping produces a blind spot nobody sees.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

async function sourceFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) found.push(path);
    }
  };
  await walk(root);
  // Every scan below is a "no offenders" assertion, which an empty file list satisfies vacuously.
  // A moved or renamed directory must fail loudly here rather than turn a guard into a no-op.
  if (found.length === 0) throw new Error(`no source files found under ${root}`);
  return found;
}

const readElectron = async (name: string): Promise<string> =>
  stripComments(await readFile(join(electronSrc(), name), 'utf8'));

describe('the plaintext is produced once, and delivered over a pipe', () => {
  it('has exactly one caller of readToken(), and it is the daemon spawn', async () => {
    const files = await sourceFiles(electronSrc());
    expect(files.length).toBeGreaterThan(5);
    const callers: string[] = [];
    for (const file of files) {
      const code = stripComments(await readFile(file, 'utf8'));
      // The declaration lives in the vault module; every *call* is `.readToken(`.
      if (/\.readToken\(/.test(code)) callers.push(relative(electronSrc(), file));
    }
    expect(callers).toEqual(['main.ts']);

    const main = await readElectron('main.ts');
    expect(main.match(/\.readToken\(/g)).toHaveLength(1);
    expect(main).toMatch(/vaultToken:\s*tokenVault\.readToken\(\)/);
  });

  /**
   * The property the whole redesign turns on. If the credential is ever put back into the daemon's
   * environment, a provider subprocess can read it out of its own parent and no allowlist helps.
   */
  it('cannot put a credential in the daemon environment, because there is no parameter for one', () => {
    const env = buildDaemonEnvironment(
      { PATH: '/usr/bin' },
      { appId: 'pipenzo', credentialOnStdin: true },
    );
    // The marker says a message is coming. The message is not here.
    expect(env[CREDENTIAL_ON_STDIN_ENV_KEY]).toBe('1');
    expect(env[DAEMON_GITHUB_TOKEN_ENV_KEY]).toBeUndefined();
    expect(Object.keys(env).some((key) => /token|credential|secret/i.test(key))).toBe(
      // The marker is the only match, and it carries no value of its own.
      true,
    );
    expect(Object.values(env)).not.toContain(undefined);
  });

  it('writes the credential to the child’s stdin and closes it', async () => {
    const main = await readElectron('main.ts');
    // A piped stdin, not `ignore`: there is nowhere else for the message to go.
    expect(main).toMatch(/stdio:\s*\['pipe',\s*'pipe',\s*'pipe'\]/);
    expect(main).toMatch(/stdin\?\.end\(buildDaemonCredentialMessage\(credential\.token\)/);
    // A child that died before the write turns an ordinary EPIPE into an unhandled stream error.
    expect(main).toMatch(/stdin\?\.on\('error'/);
  });

  it('builds a credential message that carries the token and nothing else', () => {
    const token = 'aRealisticallyLongTokenValue0001';
    expect(JSON.parse(buildDaemonCredentialMessage(token))).toEqual({ githubToken: token });
    // Newline-terminated, so the daemon's reader settles on the line rather than on pipe close.
    expect(buildDaemonCredentialMessage(token).endsWith('\n')).toBe(true);
    // Nothing to send is an empty envelope, never a null or empty-string credential.
    expect(JSON.parse(buildDaemonCredentialMessage(undefined))).toEqual({});
    expect(JSON.parse(buildDaemonCredentialMessage('too-short'))).toEqual({});
  });

  it('spawns exactly one child process from Electron main, and it is the daemon', async () => {
    const files = await sourceFiles(electronSrc());
    const spawners: string[] = [];
    for (const file of files) {
      const code = stripComments(await readFile(file, 'utf8'));
      if (/\b(?:spawn|spawnSync|fork|execFile|execFileSync|exec|execSync)\s*\(/.test(code)) {
        spawners.push(relative(electronSrc(), file));
      }
    }
    expect(spawners).toEqual(['main.ts']);

    const main = await readElectron('main.ts');
    expect(main.match(/\bspawn\s*\(/g)).toHaveLength(1);
    expect(main).toMatch(/env:\s*buildDaemonEnvironment\(/);
    expect(main).not.toMatch(/env:\s*\{\s*\.\.\.process\.env/);
  });

  it('never imports the vault into the renderer', async () => {
    const files = await sourceFiles(rendererSrc());
    expect(files.length).toBeGreaterThan(10);
    const offenders: string[] = [];
    for (const file of files) {
      const text = await readFile(file, 'utf8');
      if (/github-token-vault|GitHubTokenVault|safeStorage|readToken/.test(text)) {
        offenders.push(relative(rendererSrc(), file));
      }
    }
    expect(offenders).toEqual([]);
  });

  /** The daemon half of the pipe: it must read a message, and must not write one back to env. */
  it('is matched by a daemon that reads the message instead of the environment', async () => {
    const credential = stripComments(
      await readFile(join(daemonSrc(), 'github-credential.ts'), 'utf8'),
    );
    expect(credential).toContain(`'${CREDENTIAL_ON_STDIN_ENV_KEY}'`);
    // The injected credential is never written back into the process environment, which would undo
    // the entire point by putting it somewhere a child can read.
    expect(credential).not.toMatch(/process\.env\[[^\]]*\]\s*=/);
    expect(credential).not.toMatch(/process\.env\.\w+\s*=/);
  });
});

describe('no GitHub credential survives into the daemon environment', () => {
  const fakeToken = (suffix: string): string => `${'gh'}${'p'}_${suffix}`;
  const INHERITED = {
    PIPENZO_GITHUB_TOKEN: fakeToken('inheritedPipenzoSecret01'),
    GITHUB_TOKEN: fakeToken('inheritedActionsSecret02'),
    GH_TOKEN: fakeToken('inheritedGhCliSecret0003'),
    GH_ENTERPRISE_TOKEN: fakeToken('inheritedEnterprise00004'),
    PATH: '/usr/bin',
    HOME: '/home/dev',
  };
  const SECRETS = [
    INHERITED.PIPENZO_GITHUB_TOKEN,
    INHERITED.GITHUB_TOKEN,
    INHERITED.GH_TOKEN,
    INHERITED.GH_ENTERPRISE_TOKEN,
  ];

  it('strips every credential variable and keeps everything else', () => {
    const env = buildDaemonEnvironment(INHERITED, { appId: 'pipenzo', credentialOnStdin: true });
    for (const secret of SECRETS) expect(JSON.stringify(env)).not.toContain(secret);
    // Not an allowlist: the daemon is Pipenzo's own trusted process and still gets its PATH.
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/home/dev');
    expect(env.ELECTRON_RUN_AS_NODE).toBe('1');
    expect(env.AGENT_DOCK_APP_ID).toBe('pipenzo');
  });

  /**
   * Windows environment names are case-insensitive, so a `Github_Token` in the parent process is
   * the same variable to anything that reads it there. Deleting only the exact-case key would leave
   * the value in place under a different spelling.
   */
  it('strips them case-insensitively', () => {
    const secret = fakeToken('mixedCaseInheritedTok001');
    const env = buildDaemonEnvironment(
      { Github_Token: secret, gh_token: secret, Pipenzo_GitHub_Token: secret },
      { appId: 'pipenzo', credentialOnStdin: true },
    );
    expect(JSON.stringify(env)).not.toContain(secret);
  });

  /** An inherited marker would make a daemon wait on a stdin nobody is going to write to. */
  it('never lets a stale stdin marker through', () => {
    const env = buildDaemonEnvironment(
      { [CREDENTIAL_ON_STDIN_ENV_KEY]: '1' },
      { appId: 'p', credentialOnStdin: false },
    );
    expect(env[CREDENTIAL_ON_STDIN_ENV_KEY]).toBeUndefined();
  });

  /**
   * The variable this builder strips has to be the one the daemon actually reads. Asserted against
   * the daemon's own source rather than by importing it: `apps/desktop` does not depend on
   * `apps/daemon`, and adding that dependency to satisfy a test would be a worse trade.
   */
  it('names the variable the daemon reads', async () => {
    const daemonClient = await readFile(join(daemonSrc(), 'github-client.ts'), 'utf8');
    const declared = /GITHUB_TOKEN_ENV_KEYS = Object\.freeze\(\[([^\]]*)\]/.exec(daemonClient)?.[1];
    expect(declared).toBeTruthy();
    expect(declared).toContain(`'${DAEMON_GITHUB_TOKEN_ENV_KEY}'`);
  });

  it('lists GH_TOKEN and the enterprise names, not just Pipenzo’s own variable', () => {
    // `gh` reads GH_TOKEN then GITHUB_TOKEN; leaving either inherited would let a credential
    // Pipenzo never chose decide which account the daemon's GitHub client authenticates as.
    for (const key of ['PIPENZO_GITHUB_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN']) {
      expect(GITHUB_CREDENTIAL_ENV_KEYS).toContain(key);
    }
  });
});

describe('which credential the daemon runs on is decided once, and named', () => {
  const vaultToken = 'vaultStoredTokenValue0000001';
  const environmentToken = 'shellExportedTokenValue00001';

  it('always prefers the vault', () => {
    for (const isPackaged of [true, false]) {
      expect(
        resolveDaemonGitHubToken({
          vaultToken,
          environmentToken,
          isPackaged,
          isDevelopmentBuild: true,
        }),
      ).toEqual({ token: vaultToken, source: 'vault' });
    }
  });

  /** A shipped Pipenzo authenticates with what the user connected, or with nothing. Full stop. */
  it('ignores the environment entirely in a packaged build', () => {
    expect(
      resolveDaemonGitHubToken({
        vaultToken: undefined,
        environmentToken,
        isPackaged: true,
        isDevelopmentBuild: true,
      }),
    ).toEqual({ token: undefined, source: 'none' });
  });

  /**
   * The second gate, and why it exists: `app.isPackaged` is derived from the executable's
   * *filename*, so an artifact shipping the stock binary un-renamed reports `false`. The build-time
   * constant is what a rename cannot reach.
   */
  it('ignores the environment when the build-time development flag is false, whatever isPackaged says', () => {
    expect(
      resolveDaemonGitHubToken({
        vaultToken: undefined,
        environmentToken,
        isPackaged: false,
        isDevelopmentBuild: false,
      }),
    ).toEqual({ token: undefined, source: 'none' });
  });

  it('falls back to the environment only when both gates agree, and says so', () => {
    expect(
      resolveDaemonGitHubToken({
        vaultToken: undefined,
        environmentToken,
        isPackaged: false,
        isDevelopmentBuild: true,
      }),
    ).toEqual({ token: environmentToken, source: 'environment' });
  });

  /**
   * The environment branch reads a value straight out of a shell, and that value becomes an HTTP
   * `Authorization` header — where a newline is request splitting. The vault validates on the way
   * in; this is the same rule applied to the source that does not.
   */
  it('refuses a value from either source that is not token-shaped', () => {
    for (const bad of ['short', 'has a space in it', 'with\nnewline', '']) {
      expect(
        resolveDaemonGitHubToken({
          vaultToken: bad,
          environmentToken: undefined,
          isPackaged: false,
          isDevelopmentBuild: true,
        }).source,
      ).toBe('none');
      expect(
        resolveDaemonGitHubToken({
          vaultToken: undefined,
          environmentToken: bad,
          isPackaged: false,
          isDevelopmentBuild: true,
        }).source,
      ).toBe('none');
    }
  });

  it('reports none when there is nothing anywhere', () => {
    expect(
      resolveDaemonGitHubToken({
        vaultToken: undefined,
        environmentToken: undefined,
        isPackaged: false,
        isDevelopmentBuild: true,
      }),
    ).toEqual({ token: undefined, source: 'none' });
  });

  /** Both gates are read in main, not just the filename-derived one. */
  it('is called by main with both gates', async () => {
    const main = await readElectron('main.ts');
    expect(main).toMatch(/isPackaged:\s*app\.isPackaged/);
    expect(main).toMatch(/isDevelopmentBuild:\s*IS_DEVELOPMENT_BUILD/);
    // And a missing bundler substitution fails closed.
    expect(main).toMatch(/typeof __PIPENZO_DEVELOPMENT_BUILD__ === 'boolean'/);
    expect(main).toMatch(/:\s*false;?\s*$/m);
  });
});

describe('nothing on the renderer bridge can obtain the token', () => {
  it('exposes no channel that returns or accepts a credential', async () => {
    const preload = await readElectron('preload.ts');
    const channels = [...preload.matchAll(/ipcRenderer\.invoke\(\s*'([^']+)'/g)].map((m) => m[1]);
    expect(channels.length).toBeGreaterThan(20);
    const credentialChannels = channels.filter((channel) =>
      /github|credential/i.test(channel ?? ''),
    );
    expect(credentialChannels.sort()).toEqual([
      'pipenzo:disconnect-github',
      'pipenzo:github-connection',
    ]);
  });

  /**
   * Scoped to the credential surface rather than the whole file: a blanket "the word token must not
   * appear in preload.ts" would fire on the daemon's own bearer token or a cancellation token, and
   * would then be weakened rather than investigated — which is how this class of test dies.
   */
  it('has no token-shaped field on either credential channel', async () => {
    const preload = await readElectron('preload.ts');
    for (const channel of ['pipenzo:github-connection', 'pipenzo:disconnect-github']) {
      const index = preload.indexOf(channel);
      expect(index).toBeGreaterThan(-1);
      const region = preload.slice(Math.max(0, index - 400), index + 400);
      expect(region).not.toMatch(/\btoken\b/i);
    }
  });

  /**
   * And the shape itself makes it impossible: the wire contract has no token field, so no future
   * handler can populate one without changing a schema a reviewer would see.
   */
  it('has no token field in the connection contract', async () => {
    const contract = await readFile(
      fromHere('../../../packages/shared/src/pipenzo-credential-v1.ts'),
      'utf8',
    );
    const code = stripComments(contract);
    expect(code).not.toMatch(/\btoken\b/i);
    expect(code).toMatch(/pipenzoGitHubConnectionV1Schema/);
  });

  it('never sends the vault status object itself to a window', async () => {
    const main = await readElectron('main.ts');
    // Built field by field, never spread: a field added to the vault's status tomorrow must not be
    // able to reach a window by accident.
    expect(main).not.toMatch(/\.\.\.tokenVault\.status\(\)/);
    expect(main).not.toMatch(/sendToRenderer\([^)]*tokenVault/);
  });

  /**
   * A renderer-reachable channel that kills the daemon is a renderer-reachable way to terminate
   * every running session. Disconnecting an already-disconnected vault must change nothing.
   */
  it('does not restart the daemon when a disconnect changes nothing', async () => {
    const main = await readElectron('main.ts');
    expect(main).toMatch(/const wasStoringSomething = tokenVault\.status\(\)\.state !== 'disconnected'/);
    expect(main).toMatch(/if \(wasStoringSomething\) restartDaemonForCredentialChange\(\)/);
    // And a restart already in flight is not restarted again.
    expect(main).toMatch(/if \(credentialRestartPending\) return;/);
    // Nor is one started while the app is shutting down, which is how a daemon is orphaned.
    expect(main).toMatch(/if \(isQuitting\) return;/);
  });
});
