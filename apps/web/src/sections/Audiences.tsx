import { Container } from '../components/Container.js';
import { SectionHeading } from '../components/SectionHeading.js';
import { REPO_URL } from '../content.js';

export function Audiences() {
  return (
    <section aria-labelledby="audiences-heading" className="border-b border-border py-24 sm:py-28">
      <Container>
        <SectionHeading
          index="06"
          label="audiences"
          id="audiences-heading"
          title="Who this is for"
        />
        <div className="mt-12 grid gap-5 md:grid-cols-2">
          <article className="flex flex-col rounded-pipenzo border border-border bg-surface p-7 shadow-elevated-sm">
            <h3 className="text-xl font-semibold text-text">Developers</h3>
            <p className="mt-4 leading-relaxed text-text-soft">
              You're already paying for Claude Code or Codex, already living in GitHub issues and
              PRs, and could use a second pair of hands on the tickets that are well-specified but
              tedious. Pipenzo takes the tedious part off your plate and leaves your own coding to
              you.
            </p>
            <p className="mt-4 border-t border-border pt-4 text-sm leading-relaxed text-text-faint">
              The reviewer-grade diff view, deterministic-gates panel, and publish controls are all
              built and individually tested. Wiring them into the running app's kanban board is what
              we're working on right now.
            </p>
          </article>
          <article className="flex flex-col rounded-pipenzo border border-dashed border-surface-4 bg-transparent p-7">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-xl font-semibold text-text">Non-technical requesters</h3>
              <span className="chip chip-outline">planned</span>
            </div>
            <p className="mt-4 leading-relaxed text-text-soft">
              We're designing a plain-language view that shows the same approval and the same
              evidence a developer sees, in different words and never behind a weaker gate. You can
              see it in the product's clickable prototype today.
            </p>
            <p className="mt-4 border-t border-border pt-4 text-sm leading-relaxed text-text-faint">
              It's planned and not built yet, so for now, requesting and approving work through
              Pipenzo still means being comfortable in GitHub issues and PRs.
            </p>
          </article>
        </div>
        <p className="mt-8 text-sm text-text-faint">
          See{' '}
          <a
            href={`${REPO_URL}#design`}
            className="text-text-soft underline underline-offset-2 hover:text-text"
          >
            the design canvas
          </a>{' '}
          for the clickable preview of both, including the plain-language mode.
        </p>
      </Container>
    </section>
  );
}
