import { lstat, mkdir, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { redactSecrets, type RepoRef } from './github-client.js';
import { runGitCommand, type PipenzoGitRunner } from './pipenzo-git.js';

const MAX_ERROR_DETAIL = 2_000;

/**
 * How long the network half of a first clone may run. `pipenzo-git.ts`'s two-minute default is
 * sized for local plumbing and a push; a first clone of a real repository over a slow link can
 * legitimately take longer, and a timed-out clone is just a failed first Implement.
 */
const CLONE_TIMEOUT_MS = 10 * 60_000;

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
 * ## Concurrency: go through `RepoCheckouts`, not this function directly
 *
 * The daemon's one real caller -- `POST /v2/pipenzo/repos/checkout` (#342/#344) -- reaches this only
 * through `RepoCheckouts.resolve()`, which joins concurrent requests for the same repository onto
 * one in-flight resolution. This function does not rely on that for safety, though: before cloning
 * it *claims* `<owner>/<repo>` with a non-recursive `mkdir`, which fails with `EEXIST` if anything
 * got there first. A lost claim is `path_conflict`, and failure cleanup only ever removes a
 * directory this call's own `mkdir` created -- never one another caller (or a person) put there.
 *
 * ## Paths: every segment validated, no links, no escape from the root
 *
 * Nothing destructive happens here until the path is proven to be exactly `<root>/<owner>/<repo>`:
 *
 * - `owner` and `repo` are refused (`invalid_repository`) if they are empty, all dots, contain a
 *   separator, end in a dot or a space, end in `.git`, or are a Windows device name. Windows
 *   silently strips a trailing dot or space from a path component, so `repo.` and `repo` would
 *   otherwise be two refs naming one directory -- and the `.git` suffix is the same aliasing one
 *   level up, since a remote URL treats `repo.git` and `repo` as the same repository.
 * - The root, the owner directory and the target are `lstat`ed, and a symlink or junction at any of
 *   them is refused: this module never creates one, and following one is how a clone or an `rm`
 *   lands outside the root.
 * - Before any removal, `realpath(target)` must still sit inside `realpath(root)`.
 *
 * ## What happens when the directory already exists
 *
 * Two different things can be true of a pre-existing `<root>/<owner>/<repo>`: it is the checkout
 * Pipenzo made before (the common case -- reused as-is, no reclone), or it is something else
 * entirely (a stale directory, a manual experiment, a name collision this scheme did not
 * anticipate). `git remote get-url origin` distinguishes them: a missing or mismatched remote
 * refuses with `path_conflict` rather than running Implement against the wrong checkout, or worse,
 * cloning into a directory that already holds something unrelated.
 *
 * A matching remote is necessary but not sufficient. The clone is two steps, and the daemon can die
 * (killed, crashed, machine lost power) between `clone --no-checkout` finishing and `checkout`
 * finishing. What that leaves behind -- a valid `.git` with the right `origin` and an empty working
 * tree -- used to be trusted by the matching-remote check alone and handed to Implement as a
 * checkout, silently. So a reuse also requires the checkout to have actually happened
 * (`checkoutState()`): a `.git` *directory* (the only shape this module ever creates), an index file
 * (`clone --no-checkout` never writes one; the first successful `checkout` always does, atomically,
 * after the working tree is written), and a `HEAD` that resolves to a commit.
 *
 * - All three present: reused.
 * - No index, **and** the `.git/pipenzo-managed` ownership marker this module writes immediately
 *   after its own `clone --no-checkout`, **and** nothing in the directory except `.git`: the
 *   interrupted-clone case above, positively identified as ours and holding nothing but what our
 *   own fetch wrote. Only this state is ever removed and recloned.
 * - Anything else -- no marker (somebody else's `--no-checkout` clone, or a clone this module never
 *   made), a marker but other files beside `.git` (a checkout killed part-way, or somebody's files
 *   dropped in since), a `.git` *file* (a linked worktree or submodule), an index but no resolvable
 *   `HEAD` -- is refused with `path_conflict` and never deleted. Refusing costs a person one manual
 *   `rm`; guessing wrong costs them their work.
 *
 * And a clone that fails *within* one call (non-zero exit, timeout, a failed `symbolic-ref` or
 * `checkout`) removes its own partial directory before rethrowing -- the directory this call
 * claimed with its own `mkdir`, so everything in it is that call's own half-finished work. The next
 * call then starts from nothing rather than from a half-populated directory.
 */

/** Written into `.git/` right after this module's own fetch: the only proof a directory is ours. */
const MANAGED_MARKER = 'pipenzo-managed';

/** Windows device names, which are not usable as a directory name with or without an extension. */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

const REPOS_DIR_ENV_KEY = 'PIPENZO_REPOS_DIR';

/** The clone root: `PIPENZO_REPOS_DIR` if set, otherwise `<stateDir>/repos`. */
export function reposRoot(stateDir: string, env: NodeJS.ProcessEnv = process.env): string {
  const override = env[REPOS_DIR_ENV_KEY]?.trim();
  return override && override.length > 0 ? override : join(stateDir, 'repos');
}

export type RepoCheckoutErrorCode = 'clone_failed' | 'path_conflict' | 'invalid_repository';

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

/** `lstat`, not `stat`: nothing on these paths is ever followed through a link. */
async function lstatIfPresent(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
    throw error;
  }
}

/** See the module comment's "Paths" section for why each of these is refused. */
function assertSafeSegment(what: 'owner' | 'repository', value: string): void {
  const unsafe =
    value.length === 0 ||
    value !== value.trim() ||
    /[\\/\0:]/.test(value) ||
    /^\.+$/.test(value) ||
    /[. ]$/.test(value) ||
    /\.git$/i.test(value) ||
    WINDOWS_RESERVED.test(value);
  if (unsafe) {
    throw new RepoCheckoutError(
      'invalid_repository',
      `refusing to use ${JSON.stringify(value)} as a ${what} directory name`,
    );
  }
}

/** Refuses a symlink/junction or a non-directory at `path`; `undefined` when nothing is there. */
async function plainDirectoryIfPresent(path: string, what: string): Promise<Stats | undefined> {
  const found = await lstatIfPresent(path);
  if (!found) return undefined;
  if (found.isSymbolicLink()) {
    throw new RepoCheckoutError(
      'path_conflict',
      `${path} (${what}) is a symbolic link or junction -- refusing to follow it`,
    );
  }
  if (!found.isDirectory()) {
    throw new RepoCheckoutError(
      'path_conflict',
      `${path} (${what}) already exists and is not a directory`,
    );
  }
  return found;
}

/** Creates `path` non-recursively if missing, then insists it is a plain directory. */
async function ensurePlainDirectory(path: string, what: string): Promise<void> {
  try {
    await mkdir(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  if (!(await plainDirectoryIfPresent(path, what))) {
    throw new RepoCheckoutError('path_conflict', `${path} (${what}) could not be created`);
  }
}

/** `realpath(path)` must sit strictly inside `realpath(root)` -- checked right before any `rm`. */
async function assertInsideRoot(root: string, path: string): Promise<void> {
  const [realRoot, realPath] = await Promise.all([realpath(root), realpath(path)]);
  const rel = relative(realRoot, realPath);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new RepoCheckoutError(
      'path_conflict',
      `${path} resolves outside the managed clone root ${root} -- refusing to touch it`,
    );
  }
}

type CheckoutState =
  | { readonly kind: 'populated' }
  | { readonly kind: 'interrupted_clone' }
  | { readonly kind: 'unusable'; readonly reason: string };

/**
 * Whether a directory whose `origin` already matches is a *finished* checkout -- see the module
 * comment's "What happens when the directory already exists" for what each answer means and why
 * only a positively-identified `interrupted_clone` is ever deleted.
 */
async function checkoutState(targetDir: string, runGit: PipenzoGitRunner): Promise<CheckoutState> {
  const gitDir = await lstatIfPresent(join(targetDir, '.git'));
  if (!gitDir?.isDirectory()) {
    return { kind: 'unusable', reason: 'its .git is not a plain directory (a worktree or submodule?)' };
  }
  const index = await lstatIfPresent(join(targetDir, '.git', 'index'));
  if (!index) {
    const marker = await lstatIfPresent(join(targetDir, '.git', MANAGED_MARKER));
    if (!marker?.isFile()) {
      return { kind: 'unusable', reason: 'it has never been checked out and Pipenzo did not clone it' };
    }
    const entries = await readdir(targetDir);
    if (entries.length !== 1 || entries[0] !== '.git') {
      return {
        kind: 'unusable',
        reason: 'it is an interrupted Pipenzo clone that now has other files beside .git',
      };
    }
    return { kind: 'interrupted_clone' };
  }
  if (!index.isFile()) return { kind: 'unusable', reason: 'its .git/index is not a regular file' };
  const head = await runGit(['rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}'], targetDir);
  return head.code === 0 && head.stdout.trim().length > 0
    ? { kind: 'populated' }
    : { kind: 'unusable', reason: 'its HEAD does not resolve to a commit' };
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
  assertSafeSegment('owner', ref.owner);
  assertSafeSegment('repository', ref.repo);
  const rootDir = resolve(root);
  const ownerDir = join(rootDir, ref.owner);
  const targetDir = join(ownerDir, ref.repo);
  // Belt-and-braces over `assertSafeSegment`: the path really is exactly `<root>/<owner>/<repo>`.
  if (relative(rootDir, targetDir) !== join(ref.owner, ref.repo)) {
    throw new RepoCheckoutError(
      'invalid_repository',
      `${ref.owner}/${ref.repo} does not map to a directory directly under ${rootDir}`,
    );
  }

  await mkdir(rootDir, { recursive: true });
  await plainDirectoryIfPresent(rootDir, 'clone root');
  await ensurePlainDirectory(ownerDir, 'owner directory');

  // A non-directory occupying the path (a stray file, a leftover lock) can never be a checkout, and
  // a link is never followed -- both refused here, before spawning git in it at all.
  const existing = await plainDirectoryIfPresent(targetDir, `checkout of ${ref.owner}/${ref.repo}`);
  if (existing) {
    const remote = await runGit(['remote', 'get-url', 'origin'], targetDir);
    if (remote.code !== 0 || !remoteMatches(remote.stdout, ref)) {
      throw new RepoCheckoutError(
        'path_conflict',
        `${targetDir} already exists but is not a checkout of ${ref.owner}/${ref.repo} -- refusing ` +
          'to clone over it or use it as one.',
      );
    }
    const state = await checkoutState(targetDir, runGit);
    if (state.kind === 'populated') return targetDir;
    if (state.kind === 'unusable') {
      throw new RepoCheckoutError(
        'path_conflict',
        `${targetDir} has ${ref.owner}/${ref.repo} as its origin but ${state.reason} -- refusing ` +
          'to use or delete it. Remove it by hand and Pipenzo will clone a fresh copy.',
      );
    }
    // `interrupted_clone`: our own marker, no index, nothing beside `.git` -- a previous clone of
    // ours that died between its two steps, holding only what our own fetch wrote. Removed and
    // recloned rather than handed to Implement as an empty checkout.
    await assertInsideRoot(rootDir, targetDir);
    try {
      await rm(targetDir, { recursive: true, force: true });
    } catch (error) {
      throw new RepoCheckoutError(
        'clone_failed',
        `${targetDir} holds an interrupted clone of ${ref.owner}/${ref.repo} that could not be ` +
          `removed for a fresh one: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // Claim the path. Non-recursive on purpose: `EEXIST` means something else got here between the
  // check above and now, and this call must neither clone into it nor, on failure, remove it.
  try {
    await mkdir(targetDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new RepoCheckoutError(
        'path_conflict',
        `${targetDir} appeared while preparing a clone of ${ref.owner}/${ref.repo} -- refusing to ` +
          'clone into it.',
      );
    }
    throw error;
  }
  try {
    return await cloneInto(ref, ownerDir, targetDir, runGit);
  } catch (error) {
    // This call's own `mkdir` above created `targetDir`, so whatever is in it now is this call's
    // own partial work. Removing it is what makes the *next* call start from nothing instead of
    // from a directory with the right origin and no working tree. Best-effort: if it cannot be
    // removed, the next call's own `checkoutState()` still refuses to hand it out as a checkout.
    await assertInsideRoot(rootDir, targetDir)
      .then(() => rm(targetDir, { recursive: true, force: true }))
      .catch(() => undefined);
    throw error;
  }
}

async function cloneInto(
  ref: RepoRef,
  ownerDir: string,
  targetDir: string,
  runGit: PipenzoGitRunner,
): Promise<string> {
  const url = `https://github.com/${ref.owner}/${ref.repo}.git`;

  // Fetch only -- no working tree yet, so nothing here can trigger a smudge filter. This is the
  // one call under the wider, credential-reachable floor.
  const cloned = await runGit(['clone', '--no-checkout', url, targetDir], ownerDir, {
    credentialReachable: true,
    timeoutMs: CLONE_TIMEOUT_MS,
  });
  if (cloned.code !== 0) {
    throw new RepoCheckoutError('clone_failed', `git clone ${url} failed: ${detail(cloned)}`);
  }

  // The ownership marker, before anything else can fail: from here on, an interrupted clone left
  // on disk is one a later call can positively identify as ours (see `checkoutState()`). `wx` so a
  // marker this call did not write is never silently adopted.
  await writeFile(
    join(targetDir, '.git', MANAGED_MARKER),
    'Cloned by Pipenzo into its managed checkout directory.\n',
    { flag: 'wx' },
  );

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

/**
 * The daemon's one entry point onto `resolveRepoCheckout`: one managed clone root, and at most one
 * resolution in flight per repository.
 *
 * A second request for a repository whose resolution is still running joins that same promise
 * rather than starting its own -- the same in-flight join `routes/pipenzo-repos.ts` uses for its
 * listing. Queueing it behind the first (the `withWorkspaceQueue` shape) would also be safe, but
 * would only redo the existence check the first call's answer already settles. This is also what
 * makes a slow first clone survivable from the renderer's side: a caller whose HTTP request gave
 * up and asks again lands on the clone that is still running instead of racing a second one into
 * the same directory.
 *
 * Keyed case-insensitively because GitHub's `owner/name` is, and because on Windows and default
 * macOS filesystems `Octo/Repo` and `octo/repo` are the same directory.
 */
export class RepoCheckouts {
  readonly #inFlight = new Map<string, Promise<string>>();

  constructor(
    private readonly root: string,
    private readonly runGit: PipenzoGitRunner = runGitCommand,
  ) {}

  resolve(ref: RepoRef): Promise<string> {
    const key = `${ref.owner}/${ref.repo}`.toLowerCase();
    const existing = this.#inFlight.get(key);
    if (existing) return existing;
    const pending = resolveRepoCheckout(ref, this.root, this.runGit).finally(() => {
      // Released whether it resolved or threw, so a failed clone is retried by the next request
      // rather than every later caller joining a dead promise.
      if (this.#inFlight.get(key) === pending) this.#inFlight.delete(key);
    });
    this.#inFlight.set(key, pending);
    return pending;
  }
}
