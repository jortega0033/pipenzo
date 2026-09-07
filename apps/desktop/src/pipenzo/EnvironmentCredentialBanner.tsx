import { Banner } from '../components/primitives/Banner.js';

/**
 * Shown when the running daemon's GitHub credential came from an inherited `PIPENZO_GITHUB_TOKEN`
 * rather than from the vault (issue #113).
 *
 * `pipenzo-credential-v1.ts` carries `source` on the wire specifically so this can exist, and says
 * why: the rule epic #4 enforces is not "no credential fallbacks" — a daemon started outside
 * Electron has no other source — it is **no silent precedence**. A development build publishing as
 * whoever owns a shell variable is fine; doing it while the UI implies a stored, named account is
 * how a PR gets opened by an account nobody meant to use.
 *
 * Two limits worth stating, since a banner that overclaims is its own problem. This reports what
 * Electron main *sent* the daemon, not what the daemon resolved — a stdin handoff that failed would
 * still read as `environment` here (issue #209 is where the daemon reports its own answer back).
 * And the token itself never reaches this process, so there is nothing here to name it by.
 */
export function EnvironmentCredentialBanner() {
  return (
    <Banner tone="warn" icon="warning">
      This development build is using a <code className="mono">PIPENZO_GITHUB_TOKEN</code> from its
      own environment, not a stored account. Anything Pipenzo pushes or opens will be attributed to
      whoever owns that token. A packaged build refuses this fallback.
    </Banner>
  );
}
