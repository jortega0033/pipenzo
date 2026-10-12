import { Fragment, type ReactNode } from 'react';
import scrollRefuse from '../assets/pipenzo/web/scroll-refuse.webp';
import { Container } from '../components/Container.js';
import { SectionHeading } from '../components/SectionHeading.js';

/**
 * Plain-language outcomes only. The exact size thresholds, stack sizes, and ticket labels live in
 * README.md ("Small PRs, by construction"), which stays the source of truth; this page describes
 * the three outcomes without restating the spec. The stack drawing below is illustrative and does
 * not claim a PR count.
 */
export function SmallPrs() {
  return (
    <section
      id="small-prs"
      aria-labelledby="small-prs-heading"
      className="border-b border-border py-24 sm:py-28"
    >
      <Container>
        <SectionHeading
          index="03"
          label="pr size"
          id="small-prs-heading"
          title="Small PRs, by construction"
        >
          <p>
            Before any code gets written, Pipenzo sizes up the ticket. That size decides what shape
            the work ships in, or whether Pipenzo takes it on at all.
          </p>
        </SectionHeading>

        <ol className="mt-14 grid gap-4 rounded-pipenzo border border-border bg-surface p-4 shadow-elevated sm:p-8 md:grid-cols-3">
          <OutcomeCard label="Small change" chip={<span className="chip chip-ok">one PR</span>}>
            <p className="text-sm leading-relaxed text-text-soft">Ships as one pull request.</p>
            <div className="mt-5 flex" aria-hidden="true">
              <PrChip />
            </div>
          </OutcomeCard>

          <OutcomeCard label="Bigger change" chip={<span className="chip chip-ok">a stack</span>}>
            <p className="text-sm leading-relaxed text-text-soft">
              Splits into an ordered stack of small pull requests, each one built on the last.
            </p>
            <div className="mt-5 flex flex-wrap items-center gap-1.5" aria-hidden="true">
              {[0, 1, 2].map((i) => (
                <Fragment key={i}>
                  {i > 0 ? <Arrow /> : null}
                  <PrChip />
                </Fragment>
              ))}
            </div>
          </OutcomeCard>

          <OutcomeCard
            label="Too big to split cleanly"
            chip={<span className="chip chip-warn">handed back</span>}
          >
            <p className="text-sm leading-relaxed text-text-soft">
              Comes back to you with a size estimate and a suggested split. Pipenzo won't force it
              through as one giant PR.
            </p>
            <div className="mt-5 flex" aria-hidden="true">
              <span className="inline-flex items-center gap-1.5 rounded-pipenzo-sm border border-warn/50 bg-warn/10 px-2 py-1 font-mono text-[0.6875rem] font-semibold text-warn">
                <svg
                  viewBox="0 0 16 16"
                  className="h-3 w-3"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.6}
                >
                  <path
                    d="M6 3 2.5 6.5 6 10M2.5 6.5H10a3.5 3.5 0 0 1 0 7H8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                back to you
              </span>
            </div>
          </OutcomeCard>
        </ol>

        {/* Refusal as a state */}
        <div className="mt-16 grid items-center gap-10 md:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
          <img
            src={scrollRefuse}
            alt="Pipenzo's operator frowning at a very long scroll of checklist items, one hand on his chin, his equipment case still closed"
            width={560}
            height={568}
            loading="lazy"
            className="mx-auto w-full max-w-sm"
          />
          <div className="max-w-xl">
            <p className="eyebrow">
              <b>refusal</b> / a ticket state
            </p>
            <h3 className="mt-4 text-2xl font-bold leading-snug text-text sm:text-3xl">
              "This ticket's too big" is an answer Pipenzo is built to give.
            </h3>
            <p className="mt-4 text-lg leading-relaxed text-text-soft">
              Refusal is a real ticket state, so the agent never quietly muddles through something
              it should have handed back to you. You get the estimate and a proposed split, and you
              decide what happens next.
            </p>
          </div>
        </div>
      </Container>
    </section>
  );
}

function OutcomeCard({
  label,
  chip,
  children,
}: {
  label: string;
  chip: ReactNode;
  children: ReactNode;
}) {
  return (
    <li className="rounded-pipenzo border border-border bg-bg p-4 sm:p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-base font-semibold text-text">{label}</h3>
        {chip}
      </div>
      {children}
    </li>
  );
}

function PrChip() {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-pipenzo-sm border border-accent/50 bg-accent/10 px-2 py-1 font-mono text-[0.6875rem] font-semibold text-accent">
      <svg
        viewBox="0 0 16 16"
        className="h-3 w-3"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.6}
      >
        <circle cx="4" cy="3.5" r="1.75" />
        <circle cx="4" cy="12.5" r="1.75" />
        <circle cx="12" cy="12.5" r="1.75" />
        <path d="M4 5.25v5.5M12 10.75V7a2 2 0 0 0-2-2H7.5" strokeLinecap="round" />
      </svg>
      PR
    </span>
  );
}

function Arrow() {
  return (
    <svg
      viewBox="0 0 16 8"
      className="h-2 w-4 text-text-faint"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
    >
      <path d="M1 4h13M11 1l3 3-3 3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
