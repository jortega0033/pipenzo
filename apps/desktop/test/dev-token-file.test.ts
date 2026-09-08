import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEV_GITHUB_TOKEN_FILE, devTokenFilePath, readDevTokenFile } from '../electron/dev-token-file.js';

/**
 * Assembled at runtime so no literal in this file matches a real GitHub token pattern on disk —
 * the repository's `gitleaks` gate should never have to decide whether a fixture is a leak.
 */
const fakeToken = (suffix: string): string => `${'gh'}${'o'}_${suffix}`;
const TOKEN = fakeToken('devTokenFileFixtureValue1');

let userDataDir: string;

beforeEach(() => {
  userDataDir = mkdtempSync(join(tmpdir(), 'pipenzo-dev-token-'));
});

afterEach(() => {
  rmSync(userDataDir, { recursive: true, force: true });
});

/** Writes the fixture file with an exact mode, the same two-step `writeFileSync` + `chmodSync` the
 * real vault uses -- `writeFileSync`'s own `mode` option is masked by umask and ignored where the
 * file already exists, so only the explicit `chmodSync` actually guarantees it. */
function writeTokenFile(content: string, mode = 0o600): string {
  const path = devTokenFilePath(userDataDir);
  writeFileSync(path, content, 'utf8');
  chmodSync(path, mode);
  return path;
}

describe('devTokenFilePath', () => {
  it('joins the userData directory with the fixed file name', () => {
    expect(devTokenFilePath(userDataDir)).toBe(join(userDataDir, DEV_GITHUB_TOKEN_FILE));
  });
});

describe('readDevTokenFile', () => {
  it('returns undefined when nothing is there — the ordinary, unconfigured state', () => {
    expect(readDevTokenFile(userDataDir)).toBeUndefined();
  });

  it('reads a token from a file owned by the current user with mode 0600', () => {
    writeTokenFile(TOKEN);
    expect(readDevTokenFile(userDataDir)).toBe(TOKEN);
  });

  it('trims surrounding whitespace, the same way a developer\'s editor might leave a trailing newline', () => {
    writeTokenFile(`  ${TOKEN}\n`);
    expect(readDevTokenFile(userDataDir)).toBe(TOKEN);
  });

  it('treats a blank or whitespace-only file as unconfigured, not as an empty token', () => {
    writeTokenFile('   \n\t  ');
    expect(readDevTokenFile(userDataDir)).toBeUndefined();
  });

  /**
   * The permission check this module exists to add: a same-user process (or a different local
   * user, on a shared machine) could have widened this file's mode after a developer created it
   * more permissively than they meant to. Refusing rather than trusting existence alone is the
   * same "another party could have gotten there first" reasoning `discovery-file.ts`'s
   * `ensureSecureRuntimeDir` already applies to the daemon's own handoff directory.
   */
  it('refuses a file that is not exactly mode 0600, on POSIX', () => {
    if (process.platform === 'win32') return; // no POSIX mode to violate there
    for (const mode of [0o644, 0o640, 0o604, 0o666]) {
      writeTokenFile(TOKEN, mode);
      expect(readDevTokenFile(userDataDir)).toBeUndefined();
    }
  });

  it('accepts exactly mode 0600 after having just refused a wider one, on POSIX', () => {
    if (process.platform === 'win32') return;
    writeTokenFile(TOKEN, 0o644);
    expect(readDevTokenFile(userDataDir)).toBeUndefined();
    chmodSync(devTokenFilePath(userDataDir), 0o600);
    expect(readDevTokenFile(userDataDir)).toBe(TOKEN);
  });

  it('does not fail the whole app when the file is actually a directory', () => {
    mkdirSync(devTokenFilePath(userDataDir));
    expect(readDevTokenFile(userDataDir)).toBeUndefined();
  });

  /**
   * `statSync` on a path follows symlinks; `O_NOFOLLOW` on `openSync` does not. Without it, a
   * same-user symlink at the expected path pointing at some *other* 0600 file of theirs would pass
   * the owner/mode check on the *target* and be trusted -- the exact gap a permission check on a
   * path (rather than on an opened file descriptor) leaves open.
   */
  it('refuses a symlink even when its target is owned by the current user with mode 0600, on POSIX', () => {
    if (process.platform === 'win32') return; // no O_NOFOLLOW there; see the module's own doc comment
    const realFile = join(userDataDir, 'real-token-elsewhere');
    writeFileSync(realFile, TOKEN, 'utf8');
    chmodSync(realFile, 0o600);
    symlinkSync(realFile, devTokenFilePath(userDataDir));
    expect(readDevTokenFile(userDataDir)).toBeUndefined();
  });

  it('does not throw when the userData directory itself does not exist yet', () => {
    rmSync(userDataDir, { recursive: true, force: true });
    expect(readDevTokenFile(userDataDir)).toBeUndefined();
  });
});
