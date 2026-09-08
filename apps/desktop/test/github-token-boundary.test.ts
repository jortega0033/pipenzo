import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
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

/**
 * These scans walk two source trees and read every file in them, and several of them walk the
 * same tree over again. On an idle POSIX box that is free; on a loaded Windows runner every open
 * goes through the filesystem filter stack, and this file was overrunning its per-test budget
 * under full parallel load because of it (issue #219, same shape as
 * apps/daemon/test/publish-token-boundary.test.ts). The trees do not change during a run, so each
 * directory is walked once and each file read once. Every assertion sees exactly the bytes it saw
 * before.
 */
const treeCache = new Map<string, Promise<string[]>>();
const sourceCache = new Map<string, Promise<string>>();

function sourceFiles(root: string): Promise<string[]> {
  const cached = treeCache.get(root);
  if (cached) return cached;
  const walked = (async () => {
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
  })();
  treeCache.set(root, walked);
  return walked;
}

function readSource(file: string): Promise<string> {
  const cached = sourceCache.get(file);
  if (cached) return cached;
  const read = readFile(file, 'utf8');
  sourceCache.set(file, read);
  return read;
}

async function stripped(file: string): Promise<string> {
  return stripComments(await readSource(file));
}

const readElectron = (name: string): Promise<string> => stripped(join(electronSrc(), name));

/**
 * Warms those caches before any assertion runs, with a budget sized for the one-time tree read
 * rather than for an assertion. Reading the ~120 files of apps/desktop/electron and
 * apps/desktop/src cold is legitimately slow on a loaded Windows runner, and leaving that cost
 * inside whichever test happened to scan first is exactly how a
 * *file read* came to fail an assertion's 5 s default (issue #219). Files are read in parallel
 * here, which the sequential per-test scans could not do. Every assertion below keeps the default
 * budget and now runs against memory, so a guard that genuinely misbehaves still fails fast.
 */
async function warm(root: string): Promise<void> {
  const files = await sourceFiles(root);
  await Promise.all(files.map((file) => readSource(file)));
}

beforeAll(async () => {
  await Promise.all([warm(electronSrc()), warm(rendererSrc())]);
}, 60_000);

describe('the plaintext is produced once, and delivered over a pipe', () => {
  it('has exactly one caller of readToken(), and it is the daemon spawn', async () => {
    const files = await sourceFiles(electronSrc());
    expect(files.length).toBeGreaterThan(5);
    const callers: string[] = [];
    for (const file of files) {
      const code = await stripped(file);
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
  it('puts no credential-shaped variable in the daemon environment except the marker', () => {
    const env = buildDaemonEnvironment(
      { PATH: '/usr/bin' },
      { appId: 'pipenzo', credentialOnStdin: true },
    );
    // The marker says a message is coming. The message is not here. Asserted as an exact list
    // rather than "at least one such key exists", which would stay green if the token variable were
    // put straight back alongside it.
    expect(Object.keys(env).filter((key) => /token|credential|secret/i.test(key))).toEqual([
      CREDENTIAL_ON_STDIN_ENV_KEY,
    ]);
    expect(env[CREDENTIAL_ON_STDIN_ENV_KEY]).toBe('1');
    expect(env[DAEMON_GITHUB_TOKEN_ENV_KEY]).toBeUndefined();
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
      const code = await stripped(file);
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
      const text = await readSource(file);
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
    // the entire point by putting it somewhere a child can read. `=(?!=)` so an ordinary
    // comparison (`process.env.X === '1'`) is not mistaken for an assignment.
    expect(credential).not.toMatch(/process\.env\[[^\]]*\]\s*=(?!=)/);
    expect(credential).not.toMatch(/process\.env\.\w+\s*=(?!=)/);
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

  /**
   * Both gates are read in main, not just the filename-derived one. That the *fallback* fails
   * closed when the substitution is missing is asserted behaviourally above
   * ("ignores the environment when the build-time development flag is false"); all this checks is
   * that main actually feeds both inputs in, which no unit test of a pure function can see.
   */
  it('is called by main with both gates', async () => {
    const main = await readElectron('main.ts');
    expect(main).toMatch(/isPackaged:\s*app\.isPackaged/);
    expect(main).toMatch(/isDevelopmentBuild:\s*IS_DEVELOPMENT_BUILD/);
    expect(main).toMatch(
      /typeof __PIPENZO_DEVELOPMENT_BUILD__ === 'boolean'\s*\?\s*__PIPENZO_DEVELOPMENT_BUILD__\s*:\s*false/,
    );
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
    // An exact list, so a new credential-adjacent channel cannot appear without someone editing
    // this line and saying why. The five that exist, and what each is allowed to carry:
    //
    // - `github-connection`  — the vault's *state*. No token field exists in its schema at any
    //   depth, which the contract test below enforces separately.
    // - `disconnect-github`  — no payload at all. Only forgets.
    // - `github-device-start` — a `user_code`, which is the pairing string a human is meant to read
    //   out. Never the `device_code`, which for the length of the flow is as good as the token.
    // - `github-device-cancel` / `-open-verification` — no payload in either direction.
    // - `daemon:pipenzo-github-health-poll` (issue #257) — no payload in either direction either:
    //   it forces the reconciler's next poll, and answers once the daemon has accepted the request,
    //   never with anything the reconciler read from GitHub (that travels over
    //   `daemon:pipenzo-github-health`, a push channel this regex does not match).
    expect(credentialChannels.sort()).toEqual([
      'daemon:pipenzo-github-health-poll',
      'pipenzo:disconnect-github',
      'pipenzo:github-connection',
      'pipenzo:github-device-cancel',
      'pipenzo:github-device-open-verification',
      'pipenzo:github-device-start',
    ]);
  });

  /**
   * The device-flow half of the same rule (issue #114).
   *
   * A device flow briefly holds *two* secrets, and the second one is easy to under-rate. Anyone
   * holding the `device_code` completes the exchange the moment the user authorizes — so it is not
   * "less sensitive than the token", it is a token with a fifteen-minute life, and it stays in main
   * for exactly the same reason.
   */
  it('never lets the device code reach the renderer', async () => {
    // Word-bounded, so the *type* name `PipenzoDeviceCodeV1` (the displayable shape, which is
    // allowed here) does not read as a `deviceCode` field (which is not).
    const forbiddenField = /\bdevice_?code\b/i;
    const preload = stripComments(await readElectron('preload.ts'));
    expect(preload).not.toMatch(forbiddenField);

    const contract = stripComments(
      await readFile(fromHere('../../../packages/shared/src/pipenzo-credential-v1.ts'), 'utf8'),
    );
    expect(contract).toMatch(/pipenzoDeviceCodeV1Schema/);
    // `userCode` is the field that may exist; a `deviceCode` beside it is the mistake this guards.
    expect(contract).not.toMatch(forbiddenField);

    // And the module that holds it is a main-process module the renderer never imports. Matched on
    // the import itself rather than the bare name, and over comment-free source: a renderer file
    // that *explains* why the flow lives in main is exactly the comment this rule wants written,
    // and it must not read as a violation of the rule it is describing.
    for (const file of await sourceFiles(rendererSrc())) {
      const code = await stripped(file);
      expect(code).not.toMatch(/from\s*['"][^'"]*github-device-flow/);
      expect(code).not.toMatch(/import\s*\(\s*['"][^'"]*github-device-flow/);
    }
  });

  /**
   * The verification page is opened by main, from a URL main validated and pinned to github.com
   * itself. If the renderer could name the URL, this channel would be a general "open anything in
   * the user's browser" primitive reachable from a context that renders model-authored text — and
   * the page it opens is one that asks the user to type a credential-adjacent code.
   */
  it('does not let the renderer choose which page the sign-in opens', async () => {
    const preload = stripComments(await readElectron('preload.ts'));
    expect(preload).toMatch(/invoke\('pipenzo:github-device-open-verification'\)/);

    const main = stripComments(await readElectron('main.ts'));
    // Main reads the URL off its own session, never off the event payload.
    expect(main).toMatch(/const uri = deviceSession\.verificationUri;/);
    expect(main).toMatch(/openAllowedExternalUrl\(uri,/);
    // And re-pins the host at the moment of launch. `openAllowedExternalUrl` checks the scheme and
    // refuses userinfo, but it does not know this particular URL is only ever allowed to be
    // github.com -- so the pin is repeated where the consequence is.
    expect(main).toMatch(/hostname !== GITHUB_VERIFICATION_HOST\) return;/);
    // And the flow refuses any verification URL that is not on the pinned host in the first place.
    const flow = stripComments(await readElectron('github-device-flow.ts'));
    expect(flow).toMatch(/hostname !== GITHUB_VERIFICATION_HOST/);
    expect(flow).toMatch(/GITHUB_VERIFICATION_HOST = 'github\.com'/);
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
    // `stripComments`, like its siblings above: line-comment prose quoting the *old* form of either
    // guard below would otherwise fail this test for saying what the guard used to be.
    const main = stripComments(await readElectron('main.ts'));
    // The decision itself is `clear()`'s return value, and it is covered behaviourally in
    // `github-token-vault.test.ts` ("reports whether a disconnect actually removed anything"),
    // including the machine-without-a-credential-store case that made the previous
    // `status().state !== 'disconnected'` form of this guard permanently true. What is asserted
    // here is only the wiring: that the handler gates on that return value and on nothing else.
    expect(main).toMatch(/if \(tokenVault\.clear\(\)\) restartDaemonForCredentialChange\(\)/);
    // And specifically not on `status()`, which cannot distinguish "nothing stored" from "cannot
    // tell" and so answers the same on every machine where the loop was reachable. The quote class
    // is `['"]` rather than `'`: the reintroduction this guards against is a *rewrite*, and a
    // rewrite is exactly where a different quote style arrives.
    expect(main).not.toMatch(/tokenVault\.status\(\)[^;]*!==\s*['"]disconnected['"]/);

    // The next two guards are scoped to the restart function's own body. `if (isQuitting) return;`
    // also appears in the window-close handler, so a whole-file match would stay green with the
    // guard deleted from exactly the place it matters.
    const start = main.indexOf('function restartDaemonForCredentialChange');
    expect(start).toBeGreaterThan(-1);
    const body = main.slice(start, main.indexOf('\n}', start));
    // A restart already in flight is not restarted again — an unbounded restart loop is a
    // renderer-reachable way to terminate every running session.
    expect(body).toMatch(/if \(credentialRestartPending\) return;/);
    // Nor is one started while the app is shutting down, which is how a daemon is orphaned.
    expect(body).toMatch(/if \(isQuitting\) return;/);
  });

  /**
   * The `error`/`exit` ordering in `spawnDaemon` is the riskiest part of the credential-restart
   * work and has now produced two separate ordering bugs, both of which left a latch that refuses
   * every future credential change — or a live daemon nothing will ever kill. Neither bug is
   * reachable from a unit test without a real failing spawn or a real failing `kill()`, so the
   * ordering is pinned at the source, the same way the guards above are.
   */
  describe("spawnDaemon's child-lifecycle latches", () => {
    /** The two handler bodies, comment-free, so prose about a latch is never read as one. */
    const handlers = async (): Promise<{ error: string; exit: string }> => {
      const main = stripComments(await readElectron('main.ts'));
      const errorAt = main.indexOf("child.on('error'");
      const exitAt = main.indexOf("child.on('exit'");
      const endAt = main.indexOf('waitForDaemonReady', exitAt);
      expect(errorAt).toBeGreaterThan(-1);
      expect(exitAt).toBeGreaterThan(errorAt);
      expect(endAt).toBeGreaterThan(exitAt);
      return { error: main.slice(errorAt, exitAt), exit: main.slice(exitAt, endAt) };
    };

    /**
     * A spawn that never started emits `error` and `close` but never `exit`, and `exit` is where
     * all three latches are normally released. Left set, `daemonChild` names a process with no pid:
     * the next credential change takes it as the live daemon, arms `credentialRestartPending`,
     * kills nothing, and waits forever for an `exit` that cannot come.
     */
    it('releases every latch when a spawn never started', async () => {
      const { error } = await handlers();
      expect(error).toMatch(/daemonChild = undefined;/);
      expect(error).toMatch(/respawnAfterExit = undefined;/);
      expect(error).toMatch(/credentialRestartPending = false;/);
    });

    /**
     * And releases them *only* then. Node emits `error` on a ChildProcess for a failed `kill()` and
     * a failed `send()` too, where the child is still running — and a failing `kill()` is precisely
     * what the credential restart does on the packaging platform. Clearing `daemonChild` for a live
     * daemon makes `before-quit` short-circuit on `!daemonChild` and never call `killDaemon()`,
     * orphaning a daemon that still holds the old credential and still blocks the next launch
     * through the single-instance guard, while the next disconnect spawns a second one beside it.
     */
    it('does not clear live-daemon state for an error on a child that did start', async () => {
      const main = stripComments(await readElectron('main.ts'));
      // The discriminator has to be "did this child ever start", not "was there an error".
      expect(main).toMatch(/child\.once\(\s*['"]spawn['"]/);
      const { error } = await handlers();
      const guardAt = error.search(/if \(started\)/);
      expect(guardAt).toBeGreaterThan(-1);
      // ...and it has to return *before* the teardown, or it is not a guard.
      expect(guardAt).toBeLessThan(error.indexOf('daemonChild = undefined;'));
      expect(error.slice(guardAt)).toMatch(/return;/);
    });

    /**
     * Everything below the `!isCurrent` early return is skipped for a child that has already been
     * replaced. `credentialRestartPending` is a latch that *refuses* future credential changes
     * while set, so releasing it below that return is how one superseded child disables connecting
     * and disconnecting GitHub for the rest of the session.
     */
    it('releases the credential-restart latch above the superseded-child return', async () => {
      const { exit } = await handlers();
      const releaseAt = exit.indexOf('credentialRestartPending = false;');
      const returnAt = exit.search(/if \(!isCurrent\) return;/);
      expect(releaseAt).toBeGreaterThan(-1);
      expect(returnAt).toBeGreaterThan(-1);
      expect(releaseAt).toBeLessThan(returnAt);
    });
  });
});
