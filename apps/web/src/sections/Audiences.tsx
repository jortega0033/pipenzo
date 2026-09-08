import { Container } from '../components/Container.js';
import { REPO_URL } from '../content.js';

export function Audiences() {
  return (
    <section aria-labelledby="audiences-heading" className="border-b border-border py-20">
      <Container>
        <h2 id="audiences-heading" className="text-3xl font-bold text-text">
          Who this is for
        </h2>
        <div className="mt-10 grid gap-8 md:grid-cols-2">
          <div className="rounded-pipenzo bg-surface p-6 shadow-elevated">
            <h3 className="text-lg font-semibold text-text">Developers</h3>
            <p className="mt-3 text-text-soft">
              You're already paying for Claude Code or Codex, already living in GitHub issues and
              PRs, and could use a second pair of hands on the tickets that are well-specified but
              tedious. This isn't here to replace your own coding, it's here to take the tedious
              part off your plate. The reviewer-grade diff view, deterministic-gates panel, and
              publish controls are all built and individually tested; wiring them into the running
              app's kanban board is what we're working on right now.
            </p>
          </div>
          <div className="rounded-pipenzo bg-surface p-6 shadow-elevated">
            <h3 className="text-lg font-semibold text-text">Non-technical requesters</h3>
            <p className="mt-3 text-text-soft">
              We're designing a plain-language view that shows the same approval and the same
              evidence a developer sees, just in different words, never a weaker gate. You can see
              it in the product's clickable prototype today. It's planned, not built yet, so for
              now, requesting and approving work through Pipenzo still means being comfortable in
              GitHub issues and PRs.
            </p>
          </div>
        </div>
        <p className="mt-8 text-sm text-text-faint">
          See{' '}
          <a href={`${REPO_URL}#design`} className="underline underline-offset-2 hover:text-text-soft">
            the design canvas
          </a>{' '}
          for the clickable preview of both, including the plain-language mode.
        </p>
      </Container>
    </section>
  );
}
