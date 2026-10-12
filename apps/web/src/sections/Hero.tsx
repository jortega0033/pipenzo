import { useEffect, useState } from 'react';
import fieldEngineer from '../assets/pipenzo/web/field-engineer-hero.webp';
import { Container } from '../components/Container.js';
import { PhaseGlyph } from '../components/PhaseGlyph.js';
import { README_URL, REPO_URL, WORKFLOW_STEPS } from '../content.js';
import { usePrefersReducedMotion } from '../hooks/motion.js';
import { GitHubMark } from './SiteNav.js';

export function Hero() {
  return (
    <section
      id="top"
      aria-labelledby="hero-heading"
      className="relative overflow-hidden border-b border-border"
    >
      <Container className="relative grid grid-cols-1 items-center gap-14 pb-20 pt-14 sm:pt-20 lg:grid-cols-[minmax(0,1.08fr)_minmax(0,0.92fr)] lg:gap-8 lg:pb-28 lg:pt-24">
        <div>
          <p className="eyebrow">
            <b>open source</b> · local-first · Apache-2.0
          </p>
          <h1
            id="hero-heading"
            className="mt-6 text-[2.5rem] font-bold leading-[1.04] tracking-[-0.02em] text-text sm:text-6xl lg:text-[4.1rem]"
          >
            Pipenzo delegates engineering work{' '}
            <span className="text-accent">without delegating authority.</span>
          </h1>
          <p className="mt-7 max-w-xl text-lg leading-relaxed text-text-soft sm:text-xl">
            Point it at a GitHub issue. It refines the ticket into a spec, implements it, reviews
            it, verifies it, and hands you back a small change that becomes a pull request only when
            you approve it. Pipenzo never pushes or opens a PR on its own, and the code is built so
            that it can't.
          </p>
          <div className="mt-10 flex flex-wrap items-center gap-3">
            <a
              href={REPO_URL}
              className="inline-flex items-center gap-2 rounded-full bg-accent px-6 py-3 font-bold text-accent-fg transition hover:brightness-110 active:scale-[0.98]"
            >
              View on GitHub
            </a>
            <a
              href="#how-it-works"
              className="inline-flex items-center gap-2 rounded-full border border-surface-4 px-6 py-3 font-bold text-text transition hover:border-text-faint hover:bg-surface-2"
            >
              How it works
            </a>
          </div>
          <p className="mt-8 max-w-lg text-sm leading-relaxed text-text-faint">
            Early days, and actively being built.{' '}
            <a
              href={README_URL}
              className="text-text-soft underline underline-offset-2 hover:text-text"
            >
              The README
            </a>{' '}
            says exactly what's real today and what's still being wired in. There's no download yet.
            One will show up here when there's a real release to point you at.
          </p>
        </div>

        <div className="relative mx-auto w-full max-w-[24rem] sm:max-w-md">
          <div
            className="glow-accent pointer-events-none absolute -inset-x-16 -top-10 bottom-24"
            aria-hidden="true"
          />
          <img
            src={fieldEngineer}
            alt="Pipenzo's operator in helmet and field gear, holding a rugged laptop, an equipment case at his feet"
            width={760}
            height={1004}
            loading="eager"
            fetchPriority="high"
            className="relative mx-auto w-[66%] drop-shadow-[0_24px_40px_rgba(0,0,0,0.55)] sm:w-[70%]"
          />
          <HeroTicket />
        </div>
      </Container>
    </section>
  );
}

const TICKET_DETAIL = [
  'spec + estimate',
  '+38 −6 · 2 files',
  'gates passed',
  'verdict: pass',
  'your call',
];
const STEP_MS = 950;

/**
 * A product-styled ticket that runs once through the pipeline on load and settles on "waiting on
 * you", the state the whole page is about. It finishes in under five seconds and never loops
 * (WCAG 2.2.2); under reduced motion it renders the settled state straight away. The same
 * information is on the page as real text in How it works, so the mock is aria-hidden.
 */
function HeroTicket() {
  const reduced = usePrefersReducedMotion();
  const last = WORKFLOW_STEPS.length - 1;
  const [active, setActive] = useState(reduced ? last : 0);

  useEffect(() => {
    if (reduced) {
      setActive(last);
      return;
    }
    if (active >= last) return;
    const timer = window.setTimeout(
      () => setActive((value) => value + 1),
      active === 0 ? 700 : STEP_MS,
    );
    return () => window.clearTimeout(timer);
  }, [active, last, reduced]);

  return (
    <div
      aria-hidden="true"
      className="relative z-10 mx-auto -mt-16 w-full rounded-pipenzo border border-border bg-surface p-4 shadow-elevated sm:-mt-20"
    >
      <div className="flex items-center justify-between gap-3 border-b border-border pb-3">
        <div className="min-w-0">
          <p className="font-mono text-[0.6875rem] text-text-faint">example ticket · #94</p>
          <p className="truncate text-sm font-semibold text-text">Cache issue polls with ETags</p>
        </div>
        <span className={`chip ${active === last ? 'chip-warn' : 'chip-ok'}`}>
          {active === last ? 'needs you' : 'running'}
        </span>
      </div>
      <ol className="mt-2 space-y-0.5">
        {WORKFLOW_STEPS.map((step, index) => {
          const done = index < active;
          const current = index === active;
          const isHuman = index === last;
          return (
            <li
              key={step.phase}
              className={`ticket-row flex items-center gap-3 rounded-pipenzo-sm px-2 py-1.5 ${
                current ? 'bg-surface-3' : ''
              } ${!done && !current ? 'opacity-45' : ''}`}
            >
              <span
                className={`ticket-dot h-2 w-2 shrink-0 rounded-full ${
                  done
                    ? 'bg-accent'
                    : current
                      ? isHuman
                        ? 'bg-warn'
                        : 'bg-accent ticket-dot-active'
                      : 'bg-surface-4'
                }`}
              />
              <PhaseGlyph
                role={step.role}
                className={`h-4 w-4 shrink-0 ${current || done ? 'text-text' : 'text-text-faint'}`}
              />
              <span className="w-[4.75rem] shrink-0 text-sm font-medium text-text">
                {isHuman ? 'You' : step.phase}
              </span>
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-text-soft">
                {done || current ? TICKET_DETAIL[index] : '·'}
              </span>
              {done ? (
                <svg
                  viewBox="0 0 16 16"
                  className="h-3.5 w-3.5 shrink-0 text-accent"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path d="M3.5 8.5l3 3 6-7" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              ) : null}
              {isHuman && current ? (
                <span className="shrink-0 rounded-full bg-accent px-2.5 py-0.5 text-[0.6875rem] font-bold text-accent-fg">
                  Approve
                </span>
              ) : null}
            </li>
          );
        })}
      </ol>
      <p className="mt-3 flex items-center gap-2 border-t border-border pt-3 font-mono text-[0.6875rem] text-text-faint">
        <GitHubMark className="h-3 w-3" />
        nothing pushed · no PR opened
      </p>
    </div>
  );
}
