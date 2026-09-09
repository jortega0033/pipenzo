import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  CREDENTIAL_ON_STDIN_ENV_KEY,
  CREDENTIAL_SHAPED_ENV_KEY_PATTERN,
  DAEMON_GITHUB_TOKEN_ENV_KEY,
  GITHUB_CREDENTIAL_ENV_KEYS,
  buildDaemonCredentialMessage,
  buildDaemonEnvironment,
  buildDaemonSpawnPlan,
  reconcileDaemonTokenSource,
  resolveDaemonGitHubToken,
  type BuildDaemonSpawnPlanInput,
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

/**
 * A complete, realistic `buildDaemonSpawnPlan` input (issue #213) -- a packaged app, a real vault
 * token, nothing from the development fallback -- with any field overridable per test. Exists so
 * each test names only the field it's actually varying, the same reason `installBridge`-style
 * fixtures exist elsewhere in this codebase's own test suites.
 */
function spawnPlanInput(overrides: Partial<BuildDaemonSpawnPlanInput> = {}): BuildDaemonSpawnPlanInput {
  return {
    entry: { mainDir: '/app/electron', isDevServer: false, resourcesPath: '/app/resources' },
    appId: 'pipenzo',
    parentEnv: { PATH: '/usr/bin' },
    vaultToken: undefined,
    developmentToken: undefined,
    isPackaged: true,
    isDevelopmentBuild: false,
    developmentFallbackSuppressed: false,
    ...overrides,
  };
}

/**
 * A value that is shaped like a real GitHub token without being one, for tests that need to assert
 * a specific value never survives somewhere it shouldn't. Module-scoped (rather than local to one
 * describe block, as it originally was) so every describe below can use the same convention instead
 * of a one-off string literal.
 */
const fakeToken = (suffix: string): string => `${'gh'}${'p'}_${suffix}`;

beforeAll(async () => {
  await Promise.all([warm(electronSrc()), warm(rendererSrc()), warm(daemonSrc())]);
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
    expect(Object.keys(env).filter((key) => CREDENTIAL_SHAPED_ENV_KEY_PATTERN.test(key))).toEqual([
      CREDENTIAL_ON_STDIN_ENV_KEY,
    ]);
    expect(env[CREDENTIAL_ON_STDIN_ENV_KEY]).toBe('1');
    expect(env[DAEMON_GITHUB_TOKEN_ENV_KEY]).toBeUndefined();
  });

  it('writes the credential to the child’s stdin and closes it', async () => {
    const main = await readElectron('main.ts');
    // A piped stdin, not `ignore`: there is nowhere else for the message to go.
    expect(main).toMatch(/stdio:\s*\['pipe',\s*'pipe',\s*'pipe'\]/);
    // Behavioural, not a source-regex: `main.ts` writes `plan.credentialMessage` verbatim, and this
    // asserts what that message actually contains for a real resolved token, not merely that the
    // call is spelled a particular way (issue #213).
    const plan = buildDaemonSpawnPlan(spawnPlanInput({ vaultToken: 'aRealisticVaultToken00000001' }));
    expect(JSON.parse(plan.credentialMessage)).toEqual({ githubToken: 'aRealisticVaultToken00000001' });
    expect(main).toMatch(/stdin\?\.end\(plan\.credentialMessage/);
    // A child that died before the write turns an ordinary EPIPE into an unhandled stream error.
    expect(main).toMatch(/stdin\?\.on\('error'/);
  });

  /**
   * `credentialMessage` sits in the same plain, diagnostics-shaped object as `cwd`/`args`/`env` --
   * nothing about the shape marks it as different from those. Without a redacting `toJSON()` (and a
   * matching `util.inspect` hook), a future `console.log(plan)` or `JSON.stringify(plan)` on any
   * unrelated debug or error path would print the token in full. This is the regression three
   * separate reviewers of issue #213 flagged independently.
   */
  it('never lets the plan itself be logged or serialized with the token still in it', () => {
    const token = 'aRealisticVaultToken00000001';
    const plan = buildDaemonSpawnPlan(spawnPlanInput({ vaultToken: token }));
    expect(JSON.stringify(plan)).not.toContain(token);
    expect(JSON.stringify({ plan })).not.toContain(token);
    // `util.inspect` (and therefore `console.log`, which calls it on any non-string argument) is a
    // separate code path from `JSON.stringify` -- `toJSON` alone does not cover it.
    expect(inspect(plan)).not.toContain(token);
    // Redacted, not merely absent: a log naming the field should read as "deliberately withheld,"
    // not as a bug that silently dropped it.
    expect(JSON.stringify(plan)).toContain('[redacted]');
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
    // `main.ts` no longer builds the child's environment inline -- it spawns with `plan.env`
    // verbatim, where `plan` is `buildDaemonSpawnPlan`'s own return value. What that environment
    // actually contains is asserted behaviourally below, not by scanning how this call is typed.
    expect(main).toMatch(/env:\s*plan\.env\b/);
    expect(main).not.toMatch(/env:\s*\{\s*\.\.\.process\.env/);
  });

  /**
   * The exact regression this file's own history names (issue #213): a call site written as
   * `env: { ...buildDaemonEnvironment(...), PIPENZO_GITHUB_TOKEN: token }` would satisfy both
   * `toMatch(/env:\s*buildDaemonEnvironment\(/)` and `not.toMatch(/env:\s*\{\s*\.\.\.process\.env/)`
   * above -- a source-regex checks how the call is spelled, not what it produces. Asserting against
   * `buildDaemonSpawnPlan`'s own returned `env` object closes that gap structurally as well as in
   * the test: `main.ts` now spawns with `plan.env` directly, so there is no call site left where an
   * override like that could even be added without also changing this function.
   */
  it('puts no credential-shaped variable in the spawn plan’s environment, only the marker', () => {
    const smuggledToken = fakeToken('shouldNeverSurvive0001');
    const plan = buildDaemonSpawnPlan(
      spawnPlanInput({
        parentEnv: { PATH: '/usr/bin', PIPENZO_GITHUB_TOKEN: smuggledToken },
        vaultToken: 'aRealisticVaultToken00000001',
      }),
    );
    expect(Object.keys(plan.env).filter((key) => CREDENTIAL_SHAPED_ENV_KEY_PATTERN.test(key))).toEqual([
      CREDENTIAL_ON_STDIN_ENV_KEY,
    ]);
    expect(plan.env[DAEMON_GITHUB_TOKEN_ENV_KEY]).toBeUndefined();
    expect(plan.env[CREDENTIAL_ON_STDIN_ENV_KEY]).toBe('1');
    // The check above is name-only -- it would pass a value smuggled through under an unlisted key
    // (e.g. `PIPENZO_GH_PAT`) just as easily as the code path it is meant to catch. Assert the
    // *value* is gone from the whole environment object too, the stronger check the sibling test in
    // the next describe block already applies to `buildDaemonEnvironment` directly.
    expect(JSON.stringify(plan.env)).not.toContain(smuggledToken);
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

  /**
   * The daemon half of the pipe: it must read a message, and must not write one back to env.
   *
   * Scans the *whole* daemon source tree, not just `github-credential.ts` (issue #213's own named
   * gap): the property this test exists to protect is "the injected credential never re-enters any
   * process's environment", and a stray assignment written anywhere in `apps/daemon/src` --
   * `index.ts`, say -- would undo the whole point just as completely as one in
   * `github-credential.ts` would, and a test that only reads one file cannot see it.
   *
   * Keyed on `GITHUB_CREDENTIAL_ENV_KEYS` specifically, not on "any `process.env` assignment": the
   * daemon legitimately manages other environment variables for its own purposes (the live-smoke
   * harness's own transport-selection variable, `live-smoke/cli.ts`, is exactly that and must not
   * trip this).
   */
  it('is matched by a daemon that reads the message instead of the environment', async () => {
    const files = await sourceFiles(daemonSrc());
    expect(files.length).toBeGreaterThan(5);
    const credentialKeyPattern = GITHUB_CREDENTIAL_ENV_KEYS.join('|');
    // `=(?!=)` so an ordinary comparison (`process.env.X === '1'`) is not mistaken for an
    // assignment -- the injected credential being written back into the process environment is
    // what this guards against, not merely reading it. Case-insensitive to match the same trap
    // `buildDaemonEnvironment`'s own case-insensitive stripping exists to avoid on the other side.
    const assignsCredentialKey = new RegExp(
      `process\\.env(?:\\[['"](?:${credentialKeyPattern})['"]\\]|\\.(?:${credentialKeyPattern}))\\s*=(?!=)`,
      'i',
    );
    const offenders: string[] = [];
    for (const file of files) {
      const code = await stripped(file);
      if (assignsCredentialKey.test(code)) offenders.push(relative(daemonSrc(), file));
    }
    expect(offenders).toEqual([]);

    // Restored from this test's pre-#213 form, alongside the tree-wide scan above rather than
    // instead of it: the tree-wide scan is keyed to `GITHUB_CREDENTIAL_ENV_KEYS` specifically, so a
    // write under a sixth, unlisted credential-shaped name would pass it silently. These two
    // assertions are unkeyed and scoped to this one file -- the daemon's actual credential module --
    // and catch that case the way the original, narrower test always did. `stripped()`, not
    // `readSource()`, so a comment merely mentioning the marker string cannot spuriously satisfy the
    // `toContain` check below.
    const credential = await stripped(join(daemonSrc(), 'github-credential.ts'));
    expect(credential).toContain(`'${CREDENTIAL_ON_STDIN_ENV_KEY}'`);
    // The injected credential is never written back into the process environment, which would undo
    // the entire point by putting it somewhere a child can read. `=(?!=)` so an ordinary
    // comparison (`process.env.X === '1'`) is not mistaken for an assignment.
    expect(credential).not.toMatch(/process\.env\[[^\]]*\]\s*=(?!=)/);
    expect(credential).not.toMatch(/process\.env\.\w+\s*=(?!=)/);
  });
});

describe('no GitHub credential survives into the daemon environment', () => {
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
  const developmentToken = 'devTokenFileValue000000000001';

  it('always prefers the vault', () => {
    for (const isPackaged of [true, false]) {
      expect(
        resolveDaemonGitHubToken({
          vaultToken,
          developmentToken,
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
        developmentToken,
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
        developmentToken,
        isPackaged: false,
        isDevelopmentBuild: false,
      }),
    ).toEqual({ token: undefined, source: 'none' });
  });

  it('falls back to the environment only when both gates agree, and says so', () => {
    expect(
      resolveDaemonGitHubToken({
        vaultToken: undefined,
        developmentToken,
        isPackaged: false,
        isDevelopmentBuild: true,
      }),
    ).toEqual({ token: developmentToken, source: 'environment' });
  });

  /**
   * The development branch reads a value out of a file (issue #212 -- a shell variable before
   * that), and that value becomes an HTTP `Authorization` header — where a newline is request
   * splitting. The vault validates on the way in; this is the same rule applied to the source that
   * does not.
   */
  it('refuses a value from either source that is not token-shaped', () => {
    for (const bad of ['short', 'has a space in it', 'with\nnewline', '']) {
      expect(
        resolveDaemonGitHubToken({
          vaultToken: bad,
          developmentToken: undefined,
          isPackaged: false,
          isDevelopmentBuild: true,
        }).source,
      ).toBe('none');
      expect(
        resolveDaemonGitHubToken({
          vaultToken: undefined,
          developmentToken: bad,
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
        developmentToken: undefined,
        isPackaged: false,
        isDevelopmentBuild: true,
      }),
    ).toEqual({ token: undefined, source: 'none' });
  });

  /**
   * Issue #210: without this, disconnecting on a development build with an empty vault is a
   * no-op -- the very next spawn falls straight back to the same development-fallback token,
   * silently turning "forget this credential" into "keep using it".
   */
  describe('developmentFallbackSuppressed', () => {
    it('refuses the environment fallback once suppressed, even though the gates that allow it are met', () => {
      expect(
        resolveDaemonGitHubToken({
          vaultToken: undefined,
          developmentToken,
          isPackaged: false,
          isDevelopmentBuild: true,
          developmentFallbackSuppressed: true,
        }),
      ).toEqual({ token: undefined, source: 'none' });
    });

    it('does not suppress the vault, which is checked first and always wins', () => {
      expect(
        resolveDaemonGitHubToken({
          vaultToken,
          developmentToken,
          isPackaged: false,
          isDevelopmentBuild: true,
          developmentFallbackSuppressed: true,
        }),
      ).toEqual({ token: vaultToken, source: 'vault' });
    });

    // Defaulting to `false` is already covered by the pre-existing
    // 'falls back to the environment only when both gates agree, and says so' above, which omits
    // the parameter entirely -- a second test with the same inputs and expectation would just be
    // that one under a different name.
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

  /**
   * Issue #210: the wiring a pure-function unit test cannot see -- the disconnect handler sets the
   * process-lifetime flag unconditionally, and every spawn feeds it into `resolveDaemonGitHubToken`.
   */
  it("is suppressed for the rest of the process's life by an explicit disconnect (issue #210)", async () => {
    const main = await readElectron('main.ts');
    expect(main).toMatch(/let developmentFallbackSuppressed = false;/);
    expect(main).toMatch(/developmentFallbackSuppressed,\s*\n\s*\}\);/);
    // Set unconditionally, in the handler -- not only when `tokenVault.clear()` found a record to
    // remove. A machine with no working credential store at all (`state: 'unavailable'`,
    // `os_encryption_unavailable`/`plaintext_backend`) has no vault file `clear()` could ever find,
    // so gating this on `clear()`'s result the way the restart itself is gated would leave a daemon
    // already running on the inherited variable unsuppressed until some unrelated future restart.
    expect(main).toMatch(
      /handle\('pipenzo:disconnect-github'[\s\S]{0,600}?developmentFallbackSuppressed = true;[\s\S]{0,300}?if \(tokenVault\.clear\(\) \|\| daemonTokenSource === 'environment'\) \{\s*\n\s*void restartDaemonForCredentialChange\(\);/,
    );
  });
});

/**
 * Issue #209: `resolveDaemonGitHubToken`'s `source` is main's pre-handoff *intent*, and a failed
 * stdin write (`child.stdin` null, `EPIPE` against a child that died on spawn, a truncated write)
 * could leave the daemon with nothing while main still reported whatever it had attempted to send.
 * `reconcileDaemonTokenSource` is the confirmation step: the daemon's own `/health` report
 * (`reported`) either confirms `intended` or overrides it, and only ever overrides it downward —
 * never upgrades a `'none'` daemon report into a credentialed one, whatever main hoped for.
 */
describe('confirming what the daemon actually resolved, not just what main sent (issue #209)', () => {
  it('confirms the intended source when the daemon reports a credential arrived', () => {
    for (const intended of ['vault', 'environment', 'none'] as const) {
      expect(reconcileDaemonTokenSource(intended, 'injected')).toBe(intended);
    }
  });

  /**
   * A daemon-reported `'environment'` means the daemon fell back to its own `process.env` --
   * `buildDaemonEnvironment` always strips that variable before an Electron-managed daemon spawns,
   * so seeing this from a daemon Electron itself started means the strip did not hold. Reported
   * honestly rather than trusting whatever main intended to send.
   */
  it('reports environment when the daemon says it fell back to its own environment, regardless of intent', () => {
    for (const intended of ['vault', 'environment', 'none'] as const) {
      expect(reconcileDaemonTokenSource(intended, 'environment')).toBe('environment');
    }
  });

  /**
   * The acceptance criterion this ticket exists for: a deliberately failed stdin handoff must not
   * surface as `source: vault` (or `environment`) just because that is what main attempted to send.
   */
  it('reports none when the daemon has nothing, even if main intended to send a real credential', () => {
    for (const intended of ['vault', 'environment', 'none'] as const) {
      expect(reconcileDaemonTokenSource(intended, 'none')).toBe('none');
    }
  });

  /**
   * The wiring a pure-function unit test cannot see: `spawnDaemon` passes this child's own intended
   * source into `waitForDaemonReady`, and `daemonTokenSource` is set from the reconciled answer —
   * `health.githubCredentialSource`, defaulted to `'none'` for a daemon built before this field
   * existed -- not from `resolveDaemonGitHubToken`'s return value directly. Left as a source-regex
   * tripwire deliberately (issue #213 built the behavioural seam for the *spawn plan* itself --
   * `buildDaemonSpawnPlan`, tested above -- but `reconcileDaemonTokenSource` is already a pure,
   * independently-tested function; what's left here is a few lines of glue calling it with the
   * right arguments, exactly the "thin wiring layer" #213 says a regex is still an acceptable
   * tripwire for rather than the proof).
   */
  it('is wired into waitForDaemonReady, confirming against the health response rather than trusting intent', async () => {
    const main = await readElectron('main.ts');
    expect(main).toMatch(/waitForDaemonReady\(child, spawnedAt, plan\.credentialSource\)/);
    expect(main).toMatch(
      /daemonTokenSource = reconcileDaemonTokenSource\(\s*intendedSource,\s*health\.githubCredentialSource \?\? 'none',?\s*\)/,
    );
  });

  /**
   * The two edges a first cut of this fix missed, both caught by review: the pre-handoff intent
   * was still assigned eagerly at spawn (surviving unconfirmed forever if the daemon never became
   * ready -- a spawn failure, a health timeout), and nothing cleared it when a live daemon's
   * process exited. Both would leave `gitHubConnectionStatus()` reporting a source no daemon ever
   * confirmed, which is the exact bug #209 exists to close.
   */
  it('never assigns the unconfirmed intent to daemonTokenSource, at spawn or on exit', async () => {
    const main = await readElectron('main.ts');
    expect(main).not.toMatch(/daemonTokenSource = plan\.credentialSource/);
    expect(main).toMatch(/daemonTokenSource = 'none';\s*\n\s*if \(plan\.credentialSource === 'environment'\)/);
    // The `isCurrent` branch of the exit handler, alongside the client/daemonChild teardown it
    // already does.
    expect(main).toMatch(
      /daemonChild = undefined;[\s\S]{0,300}?daemonTokenSource = 'none';\s*\n\s*\}/,
    );
  });
});

describe('nothing on the renderer bridge can obtain the token', () => {
  it('exposes no channel that returns or accepts a credential', async () => {
    const preload = await readElectron('preload.ts');
    // Both directions, not just renderer-to-main: issue #213's reviewer flagged that an
    // `ipcRenderer.invoke(`-only scan is invisible to a main-to-renderer push channel
    // (`ipcRenderer.on(`) that could just as easily carry a token the wrong way.
    const channels = [
      ...preload.matchAll(/ipcRenderer\.(?:invoke|on)\(\s*'([^']+)'/g),
    ].map((m) => m[1]);
    expect(channels.length).toBeGreaterThan(20);
    const credentialChannels = channels.filter((channel) =>
      /github|credential/i.test(channel ?? ''),
    );
    // An exact list, so a new credential-adjacent channel cannot appear without someone editing
    // this line and saying why. What exists, and what each is allowed to carry:
    //
    // - `github-connection`  — the vault's *state*. No token field exists in its schema at any
    //   depth, which the contract test below enforces separately.
    // - `disconnect-github`  — no payload at all. Only forgets.
    // - `github-device-start` — a `user_code`, which is the pairing string a human is meant to read
    //   out. Never the `device_code`, which for the length of the flow is as good as the token.
    // - `github-device-cancel` / `-open-verification` — no payload in either direction.
    // - `github-device-outcome` (push) — `pipenzoDeviceOutcomeV1Schema`, a discriminated union of
    //   sign-in *states* (`succeeded` / `failed` / ...), never the device code or a token.
    // - `daemon:pipenzo-github-health` (push) — `pipenzoGitHubHealthV1Schema`, the same
    //   vault-state shape as `github-connection`, pushed instead of polled.
    // - `daemon:pipenzo-github-health-poll` (issue #257) — no payload in either direction either:
    //   it forces the reconciler's next poll, and answers once the daemon has accepted the request,
    //   never with anything the reconciler read from GitHub.
    expect(credentialChannels.sort()).toEqual([
      'daemon:pipenzo-github-health',
      'daemon:pipenzo-github-health-poll',
      'pipenzo:disconnect-github',
      'pipenzo:github-connection',
      'pipenzo:github-device-cancel',
      'pipenzo:github-device-open-verification',
      'pipenzo:github-device-outcome',
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
    // Issue #213's reviewer flagged the previous form of this test as "effectively vacuous": it
    // inspected an arbitrary ~800-character window around the channel string, wide enough to
    // silently pass either because it swallowed unrelated neighbouring methods (a false negative
    // if one of *them* said "token") or because it cut off mid-handler (a false negative the other
    // way). This version instead extracts the exact method body -- from its declaration to the
    // `},` that closes it at the API object's own indent level -- so what is asserted against is
    // provably the whole handler and nothing else.
    const preload = await readElectron('preload.ts');
    const methodBody = (methodName: string): string => {
      const declaration = new RegExp(`\\b${methodName}\\s*\\([^)]*\\)\\s*\\{`);
      const match = declaration.exec(preload);
      expect(match, `expected to find method ${methodName} in preload.ts`).not.toBeNull();
      const start = match!.index;
      const end = preload.indexOf('\n  },', start);
      expect(end).toBeGreaterThan(start);
      return preload.slice(start, end);
    };
    for (const methodName of ['pipenzoGitHubConnection', 'disconnectGitHub']) {
      expect(methodBody(methodName)).not.toMatch(/\btoken\b/i);
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
   * every running session. Disconnecting an already-disconnected vault, on a daemon that was not
   * running on the inherited fallback either, must change nothing.
   */
  it('does not restart the daemon when a disconnect changes nothing', async () => {
    // `stripComments`, like its siblings above: line-comment prose quoting the *old* form of either
    // guard below would otherwise fail this test for saying what the guard used to be.
    const main = stripComments(await readElectron('main.ts'));
    // Two conditions decide the restart (issue #210 added the second): `clear()`'s own report,
    // covered behaviourally in `github-token-vault.test.ts` ("reports whether a disconnect
    // actually removed anything"), including the machine-without-a-credential-store case that made
    // the previous `status().state !== 'disconnected'` form of this guard permanently true; and
    // `daemonTokenSource === 'environment'`, for the machine-without-a-credential-store case where
    // `clear()` alone would never fire even though the currently-running daemon is on the inherited
    // variable. What is asserted here is only the wiring: that the handler gates on exactly these
    // two and nothing else -- both false is still a true no-op.
    expect(main).toMatch(
      /if \(tokenVault\.clear\(\) \|\| daemonTokenSource === 'environment'\) \{[\s\S]{0,200}?void restartDaemonForCredentialChange\(\);\s*\n\s*\}/,
    );
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
   * Issue #224: a credential change used to skip straight to an uncancelled `child.kill()`, on the
   * premise that connecting and disconnecting were pre-app actions taken before any ticket could be
   * running. Settings' Account panel (#130) put "Disconnect GitHub" on a screen reachable with work
   * in flight, which made that premise false. `cancelInFlightDaemonSessions` is the same bounded
   * HTTP `sessions.cancelAll` dance `killDaemon` already performed — extracted so the two callers
   * cannot drift — and this pins that `restartDaemonForCredentialChange` actually calls it, and
   * specifically *before* the `child.kill()` it would otherwise race.
   */
  it('cancels in-flight sessions over bounded HTTP before killing the daemon for a credential change', async () => {
    const main = stripComments(await readElectron('main.ts'));
    const start = main.indexOf('function restartDaemonForCredentialChange');
    expect(start).toBeGreaterThan(-1);
    const body = main.slice(start, main.indexOf('\n}', start));
    const cancelAt = body.search(/await cancelInFlightDaemonSessions\(/);
    const killAt = body.indexOf('child.kill();');
    expect(cancelAt).toBeGreaterThan(-1);
    expect(killAt).toBeGreaterThan(-1);
    expect(cancelAt).toBeLessThan(killAt);
    // The property that actually matters is not just the ordering above but that `child.kill()`
    // is unconditional after the cancellation attempt -- `cancelInFlightDaemonSessions` cannot
    // reject in practice (`Promise.allSettled` plus a bounding `waitWithin`), but a future edit
    // wrapping the kill in a guard the cancellation could skip would silently strand the old
    // daemon holding a credential that was supposed to be replaced. Asserted as "no `return` in the
    // stretch between the two calls" rather than a full control-flow proof, which a regex cannot do.
    expect(body.slice(cancelAt, killAt)).not.toMatch(/\breturn\b/);
    // The hard-kill watchdog is armed *before* attempting the cancellation, not after `child.kill()`
    // -- its `DAEMON_CREDENTIAL_RESTART_TIMEOUT_MS` deadline is this function's one overall ceiling
    // on "how long can this leave the UI on `connecting`," and the cancellation attempt has to run
    // inside that budget rather than stack its own full timeout on top of it.
    const hardStopAt = body.indexOf('const hardStop = setTimeout(');
    expect(hardStopAt).toBeGreaterThan(-1);
    expect(hardStopAt).toBeLessThan(cancelAt);

    // The same helper `killDaemon` uses, not a second implementation the two could quietly drift on
    // (different timeout, different session enumeration, a forgotten abort-on-completion cleanup).
    const killDaemonStart = main.indexOf('async function killDaemon');
    expect(killDaemonStart).toBeGreaterThan(-1);
    const killDaemonBody = main.slice(killDaemonStart, main.indexOf('\n}', killDaemonStart));
    expect(killDaemonBody).toMatch(/await cancelInFlightDaemonSessions\(/);
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
