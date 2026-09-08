import { Banner } from '../components/primitives/Banner.js';

/**
 * Shown when the running daemon's GitHub credential came from the development fallback rather
 * than from the vault (issue #113). That fallback is a file under Electron's own data directory
 * since issue #212 — an inherited `PIPENZO_GITHUB_TOKEN` shell variable before that, moved
 * specifically so the value stops sitting in Electron main's own process environment, where a
 * provider subprocess could otherwise reach it by walking its own PPid chain.
 *
 * `pipenzo-credential-v1.ts` carries `source` on the wire specifically so this can exist, and says
 * why: the rule epic #4 enforces is not "no credential fallbacks" — a daemon started outside
 * Electron has no other source — it is **no silent precedence**. A development build publishing as
 * whoever owns that file is fine; doing it while the UI implies a stored, named account is how a
 * PR gets opened by an account nobody meant to use.
 *
 * Two limits worth stating, since a banner that overclaims is its own problem. Since issue #209,
 * this reports the daemon's own confirmed answer (reconciled against `/health`, not just what
 * Electron main intended to send) — before #209 it reported only intent, and a stdin handoff that
 * failed could still have read as `environment` here without the daemon ever actually holding a
 * credential. And the token itself never reaches this process, so there is nothing here to name it
 * by.
 */
export function EnvironmentCredentialBanner() {
  return (
    <Banner tone="warn" icon="warning">
      This development build is using a token from its own local file, not a stored account.
      Anything Pipenzo pushes or opens will be attributed to whoever owns that token. A packaged
      build refuses this fallback.
    </Banner>
  );
}
