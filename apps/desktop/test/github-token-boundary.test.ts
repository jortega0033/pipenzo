import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DAEMON_GITHUB_TOKEN_ENV_KEY,
  GITHUB_CREDENTIAL_ENV_KEYS,
  buildDaemonEnvironment,
  resolveDaemonGitHubToken,
} from '../electron/daemon-environment.js';

/**
 * Issue #165's actual acceptance criterion: **the token never reaches a provider subprocess.**
 *
 * The daemon side of this is already enforced
 * (`apps/daemon/test/publish-token-boundary.test.ts`): every provider spawn builds its environment
 * from a reviewed allowlist that no GitHub variable is on. What the vault *adds* is a second place
 * the plaintext exists — the Electron main process — and this file is that half of the invariant.
 *
 * Three properties, asserted structurally rather than by one end-to-end run, because the property
 * has to hold for every future call site and not just for whichever path a scenario happens to
 * exercise:
 *
 * 1. The plaintext is produced in exactly one place, and it goes to exactly one process.
 * 2. No inherited GitHub credential survives into the daemon child, so "which credential just
 *    pushed" has exactly one answer.
 * 3. Nothing on the renderer bridge can obtain the token, in either direction.
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

/** Strips comments, so prose *about* a forbidden pattern never reads as an occurrence of it. */
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
  return found;
}

describe('the vault produces plaintext in exactly one place', () => {
  it('has exactly one caller of readToken(), and it is the daemon spawn', async () => {
    const files = await sourceFiles(electronSrc());
    expect(files.length).toBeGreaterThan(5);
    const callers: string[] = [];
    for (const file of files) {
      const code = stripComments(await readFile(file, 'utf8'));
      // The declaration itself lives in the vault module; every *call* is `.readToken(`.
      if (/\.readToken\(/.test(code)) callers.push(relative(electronSrc(), file));
    }
    expect(callers).toEqual(['main.ts']);

    const main = stripComments(await readFile(join(electronSrc(), 'main.ts'), 'utf8'));
    expect(main.match(/\.readToken\(/g)).toHaveLength(1);
    // And that one call feeds the credential resolver, not some other consumer.
    expect(main).toMatch(/vaultToken:\s*tokenVault\.readToken\(\)/);
  });

  /**
   * The property a per-call-site check would miss: main could grow a second child process. Every
   * `spawn`/`fork`/`execFile` in the Electron main sources is enumerated here, and the daemon is
   * allowed to be the only one — because the daemon's environment is the only one this app ever
   * puts a credential into.
   */
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

    const main = stripComments(await readFile(join(electronSrc(), 'main.ts'), 'utf8'));
    expect(main.match(/\bspawn\s*\(/g)).toHaveLength(1);
    // The one spawn's env comes from the builder below, never from a raw process.env spread.
    expect(main).toMatch(/env:\s*buildDaemonEnvironment\(/);
    expect(main).not.toMatch(/env:\s*\{\s*\.\.\.process\.env/);
  });

  it('never imports the vault into the renderer', async () => {
    const files = await sourceFiles(rendererSrc());
    const offenders: string[] = [];
    for (const file of files) {
      const text = await readFile(file, 'utf8');
      if (/github-token-vault|GitHubTokenVault|safeStorage|readToken/.test(text)) {
        offenders.push(relative(rendererSrc(), file));
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('no inherited GitHub credential survives into the daemon', () => {
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
    const env = buildDaemonEnvironment(INHERITED, { appId: 'pipenzo' });
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
      { Github_Token: secret, gh_token: secret, 'Pipenzo_GitHub_Token': secret },
      { appId: 'pipenzo' },
    );
    expect(JSON.stringify(env)).not.toContain(secret);
  });

  it('puts back exactly the one token it was handed, and nothing when handed none', () => {
    const chosen = fakeToken('theOneChosenCredential01');
    const withToken = buildDaemonEnvironment(INHERITED, { appId: 'p', githubToken: chosen });
    expect(withToken[DAEMON_GITHUB_TOKEN_ENV_KEY]).toBe(chosen);
    for (const secret of SECRETS) expect(JSON.stringify(withToken)).not.toContain(secret);

    const without = buildDaemonEnvironment(INHERITED, { appId: 'p' });
    expect(without[DAEMON_GITHUB_TOKEN_ENV_KEY]).toBeUndefined();
  });

  it('treats a blank token as no token rather than as an empty credential', () => {
    const env = buildDaemonEnvironment({}, { appId: 'p', githubToken: '   ' });
    expect(env[DAEMON_GITHUB_TOKEN_ENV_KEY]).toBeUndefined();
  });

  /**
   * The variable this builder sets has to be the one the daemon actually reads. Asserted against
   * the daemon's own source rather than by importing it: `apps/desktop` does not depend on
   * `apps/daemon`, and adding that dependency to satisfy a test would be a worse trade than
   * reading one declaration.
   */
  it('sets the variable the daemon reads', async () => {
    const daemonClient = await readFile(join(daemonSrc(), 'github-client.ts'), 'utf8');
    const declared = /GITHUB_TOKEN_ENV_KEYS = Object\.freeze\(\[([^\]]*)\]/.exec(daemonClient)?.[1];
    expect(declared).toBeTruthy();
    expect(declared).toContain(`'${DAEMON_GITHUB_TOKEN_ENV_KEY}'`);
  });

  it('lists GH_TOKEN and the enterprise names, not just Pipenzo’s own variable', () => {
    // `gh` reads GH_TOKEN then GITHUB_TOKEN; leaving either inherited would let the publish path
    // authenticate as a credential Pipenzo never chose.
    for (const key of ['PIPENZO_GITHUB_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN']) {
      expect(GITHUB_CREDENTIAL_ENV_KEYS).toContain(key);
    }
  });
});

describe('which credential the daemon runs on is decided once, and named', () => {
  const vaultToken = 'vaultStoredTokenValue001';
  const environmentToken = 'shellExportedTokenValue1';

  it('always prefers the vault', () => {
    for (const isPackaged of [true, false]) {
      expect(resolveDaemonGitHubToken({ vaultToken, environmentToken, isPackaged })).toEqual({
        token: vaultToken,
        source: 'vault',
      });
    }
  });

  /** A shipped Pipenzo authenticates with what the user connected, or with nothing. Full stop. */
  it('ignores the environment entirely in a packaged build', () => {
    expect(
      resolveDaemonGitHubToken({ vaultToken: undefined, environmentToken, isPackaged: true }),
    ).toEqual({ token: undefined, source: 'none' });
  });

  /**
   * The narrow development exception, and the reason it is not the "vault, or else env" fallback
   * the GitHub client's own comment rejects: it is confined to unpackaged builds and it reports its
   * own `source`, so the precedence is visible rather than silent.
   */
  it('falls back to the environment only in development, and says so', () => {
    expect(
      resolveDaemonGitHubToken({ vaultToken: undefined, environmentToken, isPackaged: false }),
    ).toEqual({ token: environmentToken, source: 'environment' });
  });

  it('reports none when there is nothing anywhere', () => {
    expect(
      resolveDaemonGitHubToken({
        vaultToken: undefined,
        environmentToken: undefined,
        isPackaged: false,
      }),
    ).toEqual({ token: undefined, source: 'none' });
  });

  it('treats blank values as absent', () => {
    expect(
      resolveDaemonGitHubToken({ vaultToken: '   ', environmentToken: '  ', isPackaged: false }),
    ).toEqual({ token: undefined, source: 'none' });
  });
});

describe('nothing on the renderer bridge can obtain the token', () => {
  it('exposes no channel that returns or accepts a credential', async () => {
    const preload = stripComments(await readFile(join(electronSrc(), 'preload.ts'), 'utf8'));
    // The only two GitHub-credential channels are a read-only status and a disconnect.
    const channels = [...preload.matchAll(/ipcRenderer\.invoke\(\s*'([^']+)'/g)].map((m) => m[1]);
    const credentialChannels = channels.filter((channel) => /github|token|credential/i.test(channel ?? ''));
    expect(credentialChannels.sort()).toEqual([
      'pipenzo:disconnect-github',
      'pipenzo:github-connection',
    ]);
    expect(preload).not.toMatch(/\btoken\b/i);
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
    const main = stripComments(await readFile(join(electronSrc(), 'main.ts'), 'utf8'));
    // Built field by field, never spread: a field added to the vault's status tomorrow must not be
    // able to reach a window by accident.
    expect(main).not.toMatch(/\.\.\.tokenVault\.status\(\)/);
    expect(main).not.toMatch(/sendToRenderer\([^)]*tokenVault/);
  });
});
