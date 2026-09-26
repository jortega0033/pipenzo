import { mkdir, stat } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { join } from 'node:path';
import { redactSecrets, type RepoRef } from './github-client.js';
import { runGitCommand, type PipenzoGitRunner } from './pipenzo-git.js';

const MAX_ERROR_DETAIL = 2_000;

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
 * ## Why cloning never touches the daemon's GitHub token -- and why it's split into two git calls
 *
 * `pipenzo-git.ts`'s whole reason to exist is that no daemon-spawned `git` child may see the PAT
 * that lives in this process, and `credentialReachable: true` (reachability to the user's own
 * already-configured credential helper -- SSH agent, `libsecret`, Git Credential Manager, never
 * Pipenzo's own token embedded in the URL) is the one floor wide enough to let that helper answer.
 * `publish-service.ts`'s push is the only other caller of that wider floor, and it is safe there
 * specifically because a push runs no checkout and carries `--no-verify`, so no repository-supplied
 * hook or smudge filter ever executes inside it (see that module's own comment). A plain
 * `git clone` does not have that property -- it populates a working tree, which runs any
 * `filter.*.smudge` command the *cloned* repository's own `.gitattributes` names, if something by
 * that name happens to be registered in the user's global/system git config (Git LFS being the
 * common case). Running that inside the credential-reachable floor would hand an unvetted, just-
 * cloned repository's filter command the user's own SSH agent socket -- the exact exposure this
 * module's environment split exists to prevent.
 *
 * So cloning here is two git calls, not one: `clone --no-checkout` (fetch only, no working tree,
 * nothing to smudge) under `credentialReachable: true`, then `checkout` of the branch it just
 * fetched under the *default*, narrow `buildGitEnvironment()` floor -- the same floor every other
 * git command in this daemon uses. Only the network fetch ever sees the wider environment.
 *
 * ## Known gap: no lock between the existence check and the clone
 *
 * Nothing calls this function yet -- wiring it into a real request path is #342/#344's scope, not
 * this one's -- so two callers racing for the same `ref` cannot happen today. Whichever of #342/#344
 * adds the first real caller needs to either serialize on `ref` (the `withWorkspaceQueue` pattern in
 * `worktree-manager.ts` is the precedent) or confirm its own call site already can't produce
 * concurrent requests for one repo, before this stops being a theoretical gap.
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

/** Same redact-then-truncate treatment `publish-service.ts`'s own `detail()` gives git output,
 * kept consistent here rather than interpolating raw stderr/stdout into a thrown message. */
function detail(result: { readonly stdout: string; readonly stderr: string }): string {
  const text = `${result.stderr}\n${result.stdout}`.trim();
  return redactSecrets(text).slice(0, MAX_ERROR_DETAIL);
}

async function existingCheckoutStat(path: string): Promise<Stats | undefined> {
  try {
    return await stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/**
 * Whether `remoteUrl` (`git remote get-url origin`'s raw stdout) is exactly github.com's HTTPS or
 * SSH remote for `ref`, not merely a URL that happens to contain `owner/repo` as a substring.
 *
 * A naive `.includes('owner/repo')` accepts `https://github.com/owner/repo-fork.git` for
 * `owner/repo` (`"repo-fork"` starts with `"repo"`), and also accepts any host at all --
 * `https://evil.example/owner/repo.git` contains the same substring. Both are exactly the
 * wrong-checkout confusion this check exists to prevent. Anchoring the whole string against
 * `github.com`'s two remote forms and `ref`'s own two segments, with an optional `.git` suffix and
 * trailing slash, closes both gaps. This module only ever clones from `https://github.com/...`
 * itself (see below), so pinning the host here costs nothing a real clone of this repo would need;
 * a GitHub Enterprise remote at this exact deterministic path would be a pre-existing checkout this
 * module never created, which is precisely the case `path_conflict` is for.
 */
function remoteMatches(remoteUrl: string, ref: RepoRef): boolean {
  const escaped = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const owner = escaped(ref.owner);
  const repo = escaped(ref.repo);
  const pattern = new RegExp(
    `^(?:https://github\\.com/|git@github\\.com:)${owner}/${repo}(?:\\.git)?/?$`,
    'i',
  );
  return pattern.test(remoteUrl.trim());
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

  const existing = await existingCheckoutStat(targetDir);
  if (existing) {
    // A non-directory occupying the path (a stray file, a leftover lock) can never be a checkout --
    // refused here, before spawning git with a `cwd` that would just fail to launch at all.
    if (!existing.isDirectory()) {
      throw new RepoCheckoutError(
        'path_conflict',
        `${targetDir} already exists and is not a directory -- refusing to treat it as a checkout ` +
          `of ${ref.owner}/${ref.repo}.`,
      );
    }
    const remote = await runGit(['remote', 'get-url', 'origin'], targetDir);
    if (remote.code !== 0 || !remoteMatches(remote.stdout, ref)) {
      throw new RepoCheckoutError(
        'path_conflict',
        `${targetDir} already exists but is not a checkout of ${ref.owner}/${ref.repo} -- refusing ` +
          'to clone over it or use it as one.',
      );
    }
    return targetDir;
  }

  // Belt-and-braces: `git clone` already creates missing leading directories on its own, but this
  // does not depend on that being true across every git version or a future non-clone strategy.
  await mkdir(ownerDir, { recursive: true });
  const url = `https://github.com/${ref.owner}/${ref.repo}.git`;

  // Fetch only -- no working tree yet, so nothing here can trigger a smudge filter. This is the
  // one call under the wider, credential-reachable floor.
  const cloned = await runGit(['clone', '--no-checkout', url, targetDir], ownerDir, {
    credentialReachable: true,
  });
  if (cloned.code !== 0) {
    throw new RepoCheckoutError('clone_failed', `git clone ${url} failed: ${detail(cloned)}`);
  }

  // The branch `--no-checkout` left HEAD pointing at, read locally -- no network, no credential
  // reachability needed for this one.
  const branchRef = await runGit(['symbolic-ref', '--short', 'HEAD'], targetDir);
  const branch = branchRef.stdout.trim();
  if (branchRef.code !== 0 || !branch) {
    throw new RepoCheckoutError(
      'clone_failed',
      `git clone ${url} succeeded but its default branch could not be read: ${detail(branchRef)}`,
    );
  }

  // Populates the working tree -- and so is the one call that can run the cloned repo's own
  // filter.*.smudge commands, deliberately under the *default*, narrow environment rather than the
  // one the clone above used.
  const checkedOut = await runGit(['checkout', '--quiet', branch], targetDir);
  if (checkedOut.code !== 0) {
    throw new RepoCheckoutError(
      'clone_failed',
      `git clone ${url} succeeded but checking out ${branch} failed: ${detail(checkedOut)}`,
    );
  }
  return targetDir;
}
