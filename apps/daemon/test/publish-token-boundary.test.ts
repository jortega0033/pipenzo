import { readFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  PROVIDER_AUTH_ENV_KEYS,
  REVIEWED_OS_RUNTIME_ENV_KEYS,
  buildBaseProcessEnvironment,
  buildLegacyProviderEnvironment,
} from '@agent-dock/agent-runtime';
import { GITHUB_TOKEN_ENV_KEYS } from '../src/github-client.js';
import { buildGitEnvironment, buildGitPushEnvironment } from '../src/pipenzo-git.js';

/**
 * The test README's build step 4 asks for and issue #178 pulls forward to step 2: **the GitHub
 * token never reaches a provider subprocess.**
 *
 * It is written as a set of structural assertions rather than as one end-to-end run, because the
 * property has to hold for every provider, every transport, and every future spawn site — not
 * just for whichever path an integration test happens to exercise. The three things that make it
 * true are asserted directly:
 *
 * 1. The reviewed environment allowlists are allowlists, and no GitHub token variable is on one.
 * 2. Every environment builder a provider subprocess can be given drops the token, including when
 *    the daemon's own environment is the input.
 * 3. No provider-facing surface in the tree names the publish service, the token variables, or a
 *    GitHub write operation.
 */

const here = fileURLToPath(new URL('.', import.meta.url));
const daemonSrc = join(here, '..', 'src');
const runtimeSrc = join(here, '..', '..', '..', 'packages', 'agent-runtime', 'src');

/**
 * Fixture credentials are assembled at runtime, never written as literals, so no string in this
 * file matches a real GitHub token pattern on disk -- the repository's own `gitleaks` gate should
 * never have to decide whether a test fixture is a leak.
 */
const fakeToken = (suffix: string): string => `${'gh'}${'p'}_${suffix}`;

const SECRET_ENV = Object.freeze({
  PIPENZO_GITHUB_TOKEN: fakeToken('pipenzoBoundarySecret001'),
  GITHUB_TOKEN: fakeToken('pipenzoBoundarySecret002'),
  GH_TOKEN: fakeToken('pipenzoBoundarySecret003'),
  PIPENZO_GITHUB_REPO: 'jortega0033/pipenzo',
  AGENT_DOCK_PORT: '4242',
  PATH: '/usr/bin',
  HOME: '/home/dev',
  APPDATA: 'C:/AppData/Roaming',
  LOCALAPPDATA: 'C:/AppData/Local',
  SYSTEMROOT: 'C:/Windows',
});

const SECRET_VALUES = [
  SECRET_ENV.PIPENZO_GITHUB_TOKEN,
  SECRET_ENV.GITHUB_TOKEN,
  SECRET_ENV.GH_TOKEN,
];

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
      else if (entry.name.endsWith('.ts')) found.push(path);
    }
  };
  await walk(root);
  return found;
}

describe('the GitHub token never reaches a provider subprocess', () => {
  it('is absent from every reviewed environment allowlist, by name', () => {
    const allowlisted = new Set<string>([
      ...REVIEWED_OS_RUNTIME_ENV_KEYS,
      ...Object.values(PROVIDER_AUTH_ENV_KEYS).flat(),
    ]);
    for (const key of [...GITHUB_TOKEN_ENV_KEYS, 'GH_TOKEN', 'PIPENZO_GITHUB_REPO']) {
      expect(allowlisted.has(key)).toBe(false);
    }
  });

  it('is dropped by the environment builder every provider subprocess is spawned with', () => {
    for (const provider of ['claude', 'codex'] as const) {
      const env = buildLegacyProviderEnvironment(SECRET_ENV, { provider });
      const serialized = JSON.stringify(env);
      for (const secret of SECRET_VALUES) expect(serialized).not.toContain(secret);
      for (const key of GITHUB_TOKEN_ENV_KEYS) expect(env[key]).toBeUndefined();
      // Sanity: the builder is not simply returning nothing.
      expect(env.PATH).toBe('/usr/bin');
    }
  });

  it('is dropped by the base floor used for MCP servers, probes, and bare executable lookups', () => {
    const env = buildBaseProcessEnvironment(SECRET_ENV);
    for (const secret of SECRET_VALUES) expect(JSON.stringify(env)).not.toContain(secret);
    expect(env.HOME).toBe('/home/dev');
  });

  /**
   * The sharper half of this invariant, added by issue #165. Every assertion above is about
   * *inheritance* \u2014 what a child is handed. None of them helps if the token sits in the daemon's
   * own environment block, because the daemon is the **parent** of every provider subprocess and a
   * child can read its parent's initial environment (`/proc/<ppid>/environ` on Linux, the PEB on
   * Windows) regardless of what it inherited.
   *
   * So the shipped daemon is not given the token in its environment at all: Electron main writes it
   * to stdin (see `apps/desktop/electron/daemon-environment.ts` and the desktop-side boundary test)
   * and `DaemonGitHubCredential` holds it in a private field. What is asserted here is the daemon
   * half of that contract \u2014 the injected credential is never written back into `process.env`, which
   * would put it right back where a child could read it.
   */
  it('is never written back into the daemon\u2019s own environment once injected', async () => {
    const source = await readFile(join(daemonSrc, 'github-credential.ts'), 'utf8');
    const code = stripComments(source);
    // `=(?!=)` so an ordinary comparison is not mistaken for an assignment.
    expect(code).not.toMatch(/process\.env\[[^\]]*\]\s*=(?!=)/);
    expect(code).not.toMatch(/process\.env\.\w+\s*=(?!=)/);
    // Sanity: the module being scanned is the one that actually holds the credential.
    expect(code).toMatch(/class DaemonGitHubCredential/);
  });

  it('is dropped by both of Pipenzo\u2019s own git environments', () => {
    // The one process that legitimately holds the token still does not hand it to a child, so a
    // repository hook, filter or fsmonitor command cannot read it out of the environment.
    for (const env of [buildGitEnvironment(SECRET_ENV), buildGitPushEnvironment(SECRET_ENV)]) {
      for (const secret of SECRET_VALUES) expect(JSON.stringify(env)).not.toContain(secret);
    }
  });

  /**
   * The property a module-local test would miss, and the one that actually matters: `git worktree
   * add` runs a repository's `post-checkout` hook and `git status` can invoke a `core.fsmonitor`
   * command, both resolved from a `.git` an agent working in a linked worktree can write to. One
   * daemon git spawner still inheriting `process.env` would hand that agent-supplied code the PAT,
   * no matter how careful the publish service is about its own children.
   */
  it('cannot be reintroduced: no daemon source builds a child env from process.env', async () => {
    const files = await sourceFiles(daemonSrc);
    expect(files.length).toBeGreaterThan(10);
    const offenders: string[] = [];
    for (const file of files) {
      const code = stripComments(await readFile(file, 'utf8'));
      if (/\{\s*\.\.\.process\.env/.test(code)) offenders.push(relative(daemonSrc, file));
    }
    expect(offenders).toEqual([]);
  });

  it('routes every daemon git spawn through the shared hardened environment', async () => {
    const files = await sourceFiles(daemonSrc);
    const spawners: string[] = [];
    const offenders: string[] = [];
    for (const file of files) {
      const code = stripComments(await readFile(file, 'utf8'));
      if (!/execFile\(\s*'git'/.test(code) && !/spawn\(\s*'git'/.test(code)) continue;
      spawners.push(relative(daemonSrc, file));
      const hardened =
        /env:\s*buildGitEnvironment\(\)/.test(code) ||
        /env:\s*gitEnvironment\(\)/.test(code) ||
        /credentialReachable\s*\?\s*buildGitPushEnvironment\(\)\s*:\s*buildGitEnvironment\(\)/.test(code);
      if (!hardened) offenders.push(relative(daemonSrc, file));
    }
    // Sanity: the scan actually found the spawners it is meant to be policing.
    expect(spawners.length).toBeGreaterThanOrEqual(2);
    expect(offenders).toEqual([]);
  });

  it('is not addressable from an agent session: no daemon port or bearer token is in the child env', () => {
    // A session that wanted to POST to /v2/pipenzo/publish would have to discover the daemon's
    // port and its startup bearer token. Neither is on any reviewed allowlist.
    for (const provider of ['claude', 'codex'] as const) {
      const env = buildLegacyProviderEnvironment(
        { ...SECRET_ENV, AGENT_DOCK_APP_ID: 'pipenzo' },
        { provider },
      );
      expect(Object.keys(env).some((key) => key.toUpperCase().startsWith('AGENT_DOCK'))).toBe(false);
    }
  });
});

describe('the publish surface is not reachable from agent-runtime', () => {
  it('is never imported, named, or re-exported anywhere under packages/agent-runtime', async () => {
    const files = await sourceFiles(runtimeSrc);
    expect(files.length).toBeGreaterThan(20);
    const offenders: string[] = [];
    for (const file of files) {
      const text = await readFile(file, 'utf8');
      if (/publish-service|PublishService|v2\/pipenzo\/publish|PIPENZO_GITHUB_TOKEN/.test(text)) {
        offenders.push(relative(runtimeSrc, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('exposes no tool, MCP server, or capability whose name implies a GitHub write', async () => {
    const files = await sourceFiles(runtimeSrc);
    const offenders: string[] = [];
    for (const file of files) {
      const text = await readFile(file, 'utf8');
      // Matches a tool-definition-shaped mention, not a comment about the boundary.
      if (/['"`](?:git_push|gh_pr_create|github_create_pull_request|create_pull_request|publish)['"`]/.test(text)) {
        offenders.push(relative(runtimeSrc, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('keeps the Claude Agent SDK tool set free of any publishing tool', () => {
    // Narrow by design: this covers the *SDK* transport specifically. The CLI transports are
    // covered by the argv assertion below, and the environment assertions above hold for all of
    // them regardless of tool set.
    const options = readFileSync(join(runtimeSrc, 'providers', 'claude', 'sdk-options.ts'), 'utf8');
    const trusted = /TRUSTED_TOOLS = Object\.freeze\(\[([\s\S]*?)\]/.exec(options)?.[1] ?? '';
    expect(trusted).not.toBe('');
    expect(trusted).toMatch(/'Read'/);
    expect(trusted).not.toMatch(/Push|PullRequest|Publish|Git/i);
    // Bash is explicitly disallowed, which is what stops `git push` reaching the shell that way.
    expect(options).toMatch(/disallowedTools:\s*\[[^\]]*'Bash'/);
  });

  it('never hands either provider CLI a git, gh, or publish argument', async () => {
    // The transports the SDK assertion above does not reach: Claude's CLI path and Codex's. What
    // is asserted here is narrower but true for both — nothing in the argv these builders produce
    // grants a GitHub-write capability, and no `gh` binary is named anywhere in the runtime.
    for (const provider of ['claude', 'codex'] as const) {
      const args = await readFile(join(runtimeSrc, 'providers', provider, 'build-args.ts'), 'utf8');
      const code = stripComments(args);
      // Quoted so an ordinary `array.push(...)` is not mistaken for a git subcommand.
      expect(code).not.toMatch(/['"`](?:gh|git)['"`]/);
      expect(code).not.toMatch(/['"`](?:push|pull-request|pr)['"`]/i);
    }
    const files = await sourceFiles(runtimeSrc);
    const ghCallers: string[] = [];
    for (const file of files) {
      const code = stripComments(await readFile(file, 'utf8'));
      if (/execFile\(\s*['"`]gh['"`]|spawn\(\s*['"`]gh['"`]|execFile\(\s*['"`]git['"`]/.test(code)) {
        ghCallers.push(relative(runtimeSrc, file));
      }
    }
    // The runtime spawns provider CLIs, never git and never `gh`. `gh stack` is the publish
    // service's alone, once it exists (README's "complete `gh` CLI surface").
    expect(ghCallers).toEqual([]);
  });
});

describe('the publish service holds its credential narrowly', () => {
  it('reads the token in exactly one function, and stores it in no module-level binding', async () => {
    const source = await readFile(join(daemonSrc, 'publish-service.ts'), 'utf8');
    // Comments are stripped first: this module *documents* the argv shapes it refuses to use, and
    // a prose mention of `http.extraheader` must not read as an occurrence of it.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    // One call site: `#resolveToken()`. Everything else routes through it. Since issue #165 the
    // credential source is injected (the shipped daemon receives it over stdin, not from `env`), so
    // what is counted is the *invocation of the resolver*, not the name of the env reader.
    expect(code.match(/this\.#resolveCredential\(/g)).toHaveLength(1);
    // And the env reader is only ever the default, never called directly.
    expect(code).not.toMatch(/resolveGitHubToken\(/);
    // No field ever holds the token itself. `#resolveCredential` holds a *function*.
    expect(code).not.toMatch(/#token\b|this\.token\b|readonly token\b/);
    // No token ever reaches a git argv array.
    expect(code).not.toMatch(/http\.extraheader|x-access-token|--config\s+http/);
  });

  it('never logs a value derived from the token', async () => {
    const source = await readFile(join(daemonSrc, 'publish-service.ts'), 'utf8');
    for (const call of source.match(/#logger\?\.\w+\([\s\S]*?\}\);/g) ?? []) {
      expect(call).not.toMatch(/token/i);
    }
  });

  /**
   * `index.ts` is where both of the daemon's security-relevant GitHub decisions are actually made,
   * and until now nothing asserted either one. Every unit test in this area constructs its subject
   * directly, so `index.ts` could be reverted to reading `process.env` — or quietly stop passing
   * the shared ETag cache — and the whole suite would stay green.
   *
   * That is not hypothetical. Rebasing this branch onto issue #161 produced exactly the second
   * failure: git merged both sides cleanly into a `fromToken` that took no cache argument, which
   * would have shipped #161's conditional-request layer switched off in the running app while all
   * of its own tests passed. A conflict resolution is precisely where this class of bug hides, so
   * the wiring gets a tripwire of its own.
   */
  it('builds its GitHub clients from the injected credential and the shared ETag cache', async () => {
    const code = stripComments(await readFile(join(daemonSrc, 'index.ts'), 'utf8'));

    // The credential is read once, at startup, from the stdin channel — not from this process's
    // environment (issue #165).
    expect(code).toMatch(/DaemonGitHubCredential\.fromStartup\(/);
    expect(code).toMatch(/resolveGitHubCredential:\s*\(env\)\s*=>\s*githubCredential\.resolve\(env\)/);

    // Both client factories resolve through that credential, and each is handed the one per-daemon
    // conditional-request cache (issue #161). Two call sites: the phase service and the phase
    // machine.
    expect(code).toMatch(/const githubConditionalCache = new ConditionalRequestCache\(\)/);
    const allCallSites = code.match(/OctokitGitHubClient\.fromToken\(/g) ?? [];
    const wired =
      code.match(
        /OctokitGitHubClient\.fromToken\(\s*githubCredential\.resolve\(\),\s*\{\s*cache:\s*githubConditionalCache,?\s*\}/g,
      ) ?? [];
    // Both of today's call sites, and at least those two — an exact `toHaveLength(2)` would fail on
    // a legitimately-added third consumer, and would report it as "the cache wiring broke" when the
    // truth is "someone added a correctly-wired client". The property this test actually defends is
    // the one below: *every* call site is wired, whatever the count.
    expect(wired.length).toBeGreaterThanOrEqual(2);
    expect(wired.length).toBe(allCallSites.length);

    // And no path here reads a credential out of the environment for itself.
    expect(code).not.toMatch(/fromEnvironment\(/);
    expect(code).not.toMatch(/resolveGitHubToken\(/);
  });

  it('routes every string that can escape through the redactor', async () => {
    const source = await readFile(join(daemonSrc, 'publish-service.ts'), 'utf8');
    // Error messages: PublishServiceError redacts in its own constructor.
    expect(source).toMatch(/super\(redactSecrets\(message\)\)/);
    // Git output: `detail()` redacts before anything is interpolated into a message.
    expect(source).toMatch(/redactSecrets\(text\)/);
  });
});
