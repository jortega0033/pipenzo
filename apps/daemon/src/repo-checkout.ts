import { mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { RepoRef } from './github-client.js';
import { runGitCommand, type PipenzoGitRunner } from './pipenzo-git.js';

/**
 * Resolves a connected GitHub repo to the local checkout Implement cuts a worktree from (issue
 * #344), cloning it into a Pipenzo-managed directory the first time it's needed.
 *
 * ## Why Pipenzo clones rather than asking the user to point at one
 *
 * A connected repo (`pipenzoConnectedReposV1Schema`) is deliberately just an `owner/name` identity
 * -- there is no local-path field anywhere upstream of this module, by that schema's own design.
 * Requiring the user to locate and select an existing clone before the first Implement would put a
 * manual step between "connect a repo" (#115) and "start a ticket" (#83) for every repo, on every
 * machine Pipenzo runs on. Cloning it ourselves makes the board's Implement action self-contained.
 *
 * ## Where clones live, and how that's overridden
 *
 * `<state dir>/repos/<owner>/<repo>`, nested by owner rather than flattened, because two connected
 * repos from different owners sharing a name (a real possibility with 50 allowed connections) would
 * otherwise collide on a single directory. `PIPENZO_REPOS_DIR` overrides the root the same way
 * `AGENT_DOCK_STATE_DIR` overrides the whole state directory (`state-directory.ts`) -- the same
 * override shape, so a development machine can point Pipenzo's clones somewhere other than the
 * hidden per-user app-data directory without a second configuration mechanism to learn.
 *
 * ## Why cloning never touches the daemon's GitHub token
 *
 * `pipenzo-git.ts`'s whole reason to exist is that no daemon-spawned `git` child may see the PAT
 * that lives in this process. A clone is exactly the same class of operation as the push in
 * `publish-service.ts`, so it uses the same `credentialReachable: true` floor: reachability to the
 * user's own already-configured credential helper (SSH agent, `libsecret`, Git Credential Manager),
 * never Pipenzo's own token embedded in the URL.
 *
 * ## What happens when the directory already exists
 *
 * Two different things can be true of a pre-existing `<root>/<owner>/<repo>`: it is the checkout
 * Pipenzo made before (the common case -- reused as-is, no reclone), or it is something else
 * entirely (a stale directory, a manual experiment, a name collision this scheme did not
 * anticipate). `git remote get-url origin` distinguishes them: a missing or mismatched remote
 * refuses with `path_conflict` rather than running Implement against the wrong checkout, or worse,
 * cloning into a directory that already holds something unrelated.
 */

const REPOS_DIR_ENV_KEY = 'PIPENZO_REPOS_DIR';

/** The clone root: `PIPENZO_REPOS_DIR` if set, otherwise `<stateDir>/repos`. */
export function reposRoot(stateDir: string, env: NodeJS.ProcessEnv = process.env): string {
  const override = env[REPOS_DIR_ENV_KEY]?.trim();
  return override && override.length > 0 ? override : join(stateDir, 'repos');
}

export type RepoCheckoutErrorCode = 'clone_failed' | 'path_conflict';

export class RepoCheckoutError extends Error {
  constructor(
    readonly code: RepoCheckoutErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RepoCheckoutError';
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * Returns the absolute local path for `ref`, cloning it under `root` first if nothing is there yet.
 * Deterministic and idempotent: the same `ref`/`root` pair always names the same directory, so no
 * separate persisted mapping is needed alongside it.
 */
export async function resolveRepoCheckout(
  ref: RepoRef,
  root: string,
  runGit: PipenzoGitRunner = runGitCommand,
): Promise<string> {
  const ownerDir = join(root, ref.owner);
  const targetDir = join(ownerDir, ref.repo);

  if (await pathExists(targetDir)) {
    const remote = await runGit(['remote', 'get-url', 'origin'], targetDir);
    const expected = `${ref.owner}/${ref.repo}`.toLowerCase();
    if (remote.code !== 0 || !remote.stdout.toLowerCase().includes(expected)) {
      throw new RepoCheckoutError(
        'path_conflict',
        `${targetDir} already exists but is not a checkout of ${ref.owner}/${ref.repo} -- refusing ` +
          'to clone over it or use it as one.',
      );
    }
    return targetDir;
  }

  await mkdir(ownerDir, { recursive: true });
  const url = `https://github.com/${ref.owner}/${ref.repo}.git`;
  const result = await runGit(['clone', url, targetDir], ownerDir, { credentialReachable: true });
  if (result.code !== 0) {
    throw new RepoCheckoutError(
      'clone_failed',
      `git clone ${url} failed: ${result.stderr || result.stdout || `exit ${result.code}`}`,
    );
  }
  return targetDir;
}
