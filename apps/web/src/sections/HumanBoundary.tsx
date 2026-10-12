import approvalBoundary from '../assets/pipenzo/illustrations/pipenzo-human-approval-boundary-1600x900.webp';
import type { ReactNode } from 'react';
import { Container } from '../components/Container.js';
import { SectionHeading } from '../components/SectionHeading.js';
import { BOUNDARY_TEST_URL, PUBLISH_SERVICE_URL, REPO_URL } from '../content.js';
import { GitHubMark } from './SiteNav.js';

/**
 * The proof behind the hero's "never pushes without you" claim, placed directly after the
 * pipeline so a skeptical reader meets it early. The source claim and the has / does-not-have
 * diagram come first, both files link to their real source on GitHub, then the art, then a CTA
 * so the page doesn't go quiet between the hero buttons and the closing section.
 *
 * The art is shown whole, at its native 16:9, inside a framed "console" window. The earlier
 * version used it as an object-cover background with text on top, which cropped the figure at
 * desktop widths and put body copy over busy art at low contrast. Here the image never crops at
 * any width.
 */
export function HumanBoundary() {
  return (
    <section
      id="boundary"
      aria-labelledby="human-boundary-heading"
      className="relative overflow-hidden border-b border-border bg-surface/40 py-24 sm:py-28"
    >
      <Container>
        <SectionHeading
          index="02"
          label="human boundary"
          id="human-boundary-heading"
          title="The write capability never reaches the agent."
        />

        <div className="mt-12 grid grid-cols-1 gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:gap-14">
          <div className="space-y-4 text-lg leading-relaxed text-text-soft">
            <p>
              <SourceLink href={PUBLISH_SERVICE_URL}>apps/daemon/src/publish-service.ts</SourceLink>{' '}
              is the only code in the repo that can call{' '}
              <code className="font-mono text-text">git push</code> or open a pull request. It runs
              daemon-side, behind its own route, and{' '}
              <SourceLink href={BOUNDARY_TEST_URL}>publish-token-boundary.test.ts</SourceLink>{' '}
              asserts that the GitHub token can never reach an agent-callable path.
            </p>
            <p>
              Nobody has to tell the agent not to push. It has no path to do it. That boundary is
              built into the repo's structure, and no prompt is involved in keeping it.
            </p>
          </div>

          {/* Boundary diagram */}
          <div
            className="grid gap-3 sm:grid-cols-[1fr_auto_1fr] sm:items-stretch"
            aria-label="Where the push capability lives"
            role="group"
          >
            <div className="rounded-pipenzo border border-border bg-surface p-5">
              <p className="eyebrow">agent sessions</p>
              <p className="mt-2 text-sm text-text-soft">Refine, Implement, Review, Verify</p>
              <ul className="mt-4 space-y-2 font-mono text-xs">
                <li className="flex items-center gap-2 text-text-soft">
                  <Mark ok={false} /> GitHub token
                </li>
                <li className="flex items-center gap-2 text-text-soft">
                  <Mark ok={false} /> git push
                </li>
                <li className="flex items-center gap-2 text-text-soft">
                  <Mark ok={false} /> open a PR
                </li>
              </ul>
            </div>
            <div className="flex items-center justify-center gap-2 sm:flex-col" aria-hidden="true">
              <div className="boundary-wall h-[2px] w-10 [--wall-dir:to_right] sm:h-full sm:w-[2px] sm:[--wall-dir:to_bottom]" />
              <svg
                viewBox="0 0 16 16"
                className="h-5 w-5 shrink-0 text-text-faint"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.5}
              >
                <rect x="3" y="7" width="10" height="7" rx="1.5" />
                <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
              </svg>
              <div className="boundary-wall h-[2px] w-10 [--wall-dir:to_right] sm:h-full sm:w-[2px] sm:[--wall-dir:to_bottom]" />
            </div>
            <div className="rounded-pipenzo border border-accent/50 bg-surface-2 p-5">
              <p className="eyebrow">publish-service.ts</p>
              <p className="mt-2 text-sm text-text-soft">daemon-side, own route</p>
              <ul className="mt-4 space-y-2 font-mono text-xs">
                <li className="flex items-center gap-2 text-text-soft">
                  <Mark ok /> GitHub token
                </li>
                <li className="flex items-center gap-2 text-text-soft">
                  <Mark ok /> git push
                </li>
                <li className="flex items-center gap-2 text-text-soft">
                  <Mark ok /> open a PR
                </li>
                <li className="flex items-center gap-2 text-warn">
                  <Mark warn /> after you approve
                </li>
              </ul>
            </div>
          </div>
        </div>

        <figure className="mt-12 overflow-hidden rounded-pipenzo border border-border bg-bg shadow-elevated">
          <div
            className="flex items-center justify-between gap-4 border-b border-border px-4 py-2.5"
            aria-hidden="true"
          >
            <div className="flex gap-1.5">
              <span className="h-2.5 w-2.5 rounded-full bg-surface-4" />
              <span className="h-2.5 w-2.5 rounded-full bg-surface-4" />
              <span className="h-2.5 w-2.5 rounded-full bg-surface-4" />
            </div>
            <span className="truncate font-mono text-[0.6875rem] text-text-faint">
              publish gate · waiting on you
            </span>
            <span className="chip chip-warn hidden sm:inline-flex">needs you</span>
          </div>
          <img
            src={approvalBoundary}
            alt="Pipenzo's operator standing with his hands off the controls beside a console that reads Work Complete, with every check passed. To his right, a glowing panel reads Your Approval above a green approval button that nobody has pressed."
            width={1600}
            height={900}
            loading="lazy"
            className="block aspect-[16/9] h-auto w-full"
          />
        </figure>

        <div className="mt-12 flex flex-col gap-5 rounded-pipenzo border border-border bg-surface p-6 sm:flex-row sm:items-center sm:justify-between sm:p-7">
          <p className="max-w-xl text-text-soft">
            <span className="font-semibold text-text">Check the boundary yourself.</span> The publish
            service and its boundary test are both public, along with the rest of the repo.
          </p>
          <div className="flex shrink-0 flex-wrap gap-3">
            <a
              href={REPO_URL}
              className="inline-flex items-center gap-2 rounded-full bg-accent px-5 py-2.5 font-bold text-accent-fg transition hover:brightness-110 active:scale-[0.98]"
            >
              <GitHubMark className="h-4 w-4" />
              Browse the repo
            </a>
            <a
              href="#status"
              className="inline-flex items-center gap-2 rounded-full border border-surface-4 px-5 py-2.5 font-bold text-text transition hover:border-text-faint hover:bg-surface-2"
            >
              What's built today
            </a>
          </div>
        </div>
      </Container>
    </section>
  );
}

/** An inline code-styled link to a real source file on GitHub. */
function SourceLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      className="rounded bg-surface-3 px-1.5 py-0.5 font-mono text-[0.9em] text-text [overflow-wrap:anywhere] underline decoration-text-faint underline-offset-4 transition-colors hover:text-accent hover:decoration-accent"
    >
      {children}
    </a>
  );
}

function Mark({ ok, warn }: { ok?: boolean; warn?: boolean }) {
  const label = warn ? 'only' : ok ? 'has' : 'does not have';
  return (
    <>
      <span className="sr-only">{label}: </span>
      {warn ? (
        <svg
          viewBox="0 0 16 16"
          className="h-3.5 w-3.5 shrink-0"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.8}
          aria-hidden="true"
        >
          <circle cx="8" cy="8" r="5.5" />
          <path d="M8 5v3.5l2 1.5" strokeLinecap="round" />
        </svg>
      ) : ok ? (
        <svg
          viewBox="0 0 16 16"
          className="h-3.5 w-3.5 shrink-0 text-accent"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          aria-hidden="true"
        >
          <path d="M3.5 8.5l3 3 6-7" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : (
        <svg
          viewBox="0 0 16 16"
          className="h-3.5 w-3.5 shrink-0 text-danger-text"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          aria-hidden="true"
        >
          <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" strokeLinecap="round" />
        </svg>
      )}
    </>
  );
}
