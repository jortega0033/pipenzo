import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A developer-supplied GitHub token, read from a file instead of an inherited shell variable
 * (issue #212).
 *
 * ## The problem this closes
 *
 * `resolveDaemonGitHubToken`'s development fallback used to read `process.env.PIPENZO_GITHUB_TOKEN`
 * directly. That means an operator testing the desktop app in development exported the token into
 * the shell that launched Electron, so it sat in **Electron main's own environment block** for the
 * life of the app. Issue #165's whole argument — a child can read its parent's initial environment
 * regardless of what it inherited — is not scoped to the *immediate* parent: a provider subprocess
 * can walk its own PPid chain (provider → daemon → Electron main) and read the grandparent's
 * environ on Linux (`PTRACE_MODE_READ`, ungated by Yama for a same-uid process) or macOS. `delete
 * process.env.PIPENZO_GITHUB_TOKEN` after reading does not fix this — the `/proc` copy is taken at
 * `exec`, before any in-process delete could run.
 *
 * A file this module reads once, at spawn, and only Electron main ever opens, never enters any
 * process's environment block at all, so there is nothing for a PPid walk to find.
 *
 * ## Why a file rather than, say, an IPC-delivered value or a config setting
 *
 * The same reason `resolveDaemonGitHubToken`'s vault path is a file, not a setting: a developer
 * needs to place this value *before* Electron starts, from outside the running app (there is no
 * renderer-facing "paste your dev token here" surface, and building one would put a text box for a
 * PAT in the one process this whole epic exists to keep tokens out of). A file under Electron's own
 * `userData` directory is the same trust boundary the real vault (`github-token-vault.ts`) already
 * uses — same directory, same "runs as the same OS user" argument — just unencrypted and
 * developer-managed rather than main-written and encrypted, because this is a development
 * convenience, not the product's real credential store.
 *
 * ## What this still does not fix, stated precisely so it is not read as more than it is
 *
 * On Windows — the packaging platform — reading another same-user process's environment and
 * reading its heap are the same operation (`OpenProcess` + `ReadProcessMemory`, no debug privilege
 * needed at equal integrity), so moving the token out of the environment buys nothing there; see
 * `github-credential.ts`'s identical note for the daemon's own equivalent fallback. What this fixes
 * is specifically the Linux/macOS PPid-walk-of-`/proc`-or-`procargs2` route through **Electron
 * main's** environment. It does not touch the daemon's own separate, already-documented direct-env
 * fallback (`github-credential.ts`, used only when the daemon is started with no Electron parent at
 * all — `pnpm --filter @agent-dock/daemon dev`, the live-smoke harness, CI) — that path never went
 * through Electron main's environment in the first place, so this file has nothing to say about it.
 */
export const DEV_GITHUB_TOKEN_FILE = 'dev-github-token';

/** Where a developer places the file, under Electron's own per-app data directory. */
export function devTokenFilePath(userDataDir: string): string {
  return join(userDataDir, DEV_GITHUB_TOKEN_FILE);
}

/**
 * Reads the file if, and only if, it looks like something a developer deliberately placed for this
 * purpose — never throws, because every failure mode here (absent, unreadable, wrong permissions,
 * empty) is "no development token configured," an ordinary, already-handled state, not a startup
 * fault.
 *
 * Mirrors `discovery-file.ts`'s `ensureSecureRuntimeDir` reasoning, aimed the other way: that
 * function verifies a directory *before the daemon writes to it*; this verifies a file *before
 * Electron main trusts what is already in it*, since here the developer is the writer and this
 * process is only ever the reader. A same-user process could still have pre-staged or widened this
 * file, which is exactly why the mode check exists rather than trusting existence alone — the same
 * "another local user (or process) could have gotten there first" concern `ensureSecureRuntimeDir`
 * documents, applied to a file instead of a directory.
 *
 * POSIX-only for the permission check, for the same reason `ensureSecureRuntimeDir` and
 * `github-token-vault.ts`'s discovery-file counterpart are: Windows has no equivalent of a POSIX
 * file mode, and NTFS ACLs on a per-user profile directory are already restrictive by inheritance,
 * so a `chmod`-style check there would be a claim this codebase cannot actually verify.
 */
export function readDevTokenFile(userDataDir: string): string | undefined {
  const path = devTokenFilePath(userDataDir);
  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(path);
  } catch {
    return undefined;
  }
  if (!stats.isFile()) return undefined;
  if (process.platform !== 'win32') {
    const ownedByUs = typeof process.getuid === 'function' ? stats.uid === process.getuid() : true;
    const mode = stats.mode & 0o777;
    if (!ownedByUs || mode !== 0o600) {
      console.warn(
        `[pipenzo] ignoring ${path}: expected it to be owned by the current user with mode 0600, ` +
          `but found owner uid ${stats.uid} mode ${mode.toString(8)}. Run "chmod 600 ${path}" and ` +
          'try again -- a file another local user or process can read is not a safe place to keep a token.',
      );
      return undefined;
    }
  }
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
