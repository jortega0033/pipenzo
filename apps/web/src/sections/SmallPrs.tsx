import oversizedTicket from '../assets/pipenzo/illustrations/pipenzo-oversized-ticket-1600x900.webp';
import { Container } from '../components/Container.js';
import { DIFF_SIZE_THRESHOLDS } from '../content.js';

export function SmallPrs() {
  const { soloPr, stackedPrs } = DIFF_SIZE_THRESHOLDS;
  return (
    <section aria-labelledby="small-prs-heading" className="border-b border-border py-20">
      <Container className="grid items-center gap-12 lg:grid-cols-2">
        <div>
          <h2 id="small-prs-heading" className="text-3xl font-bold text-text">
            Small PRs, by construction
          </h2>
          <p className="mt-4 text-text-soft">
            Before a single line gets written, the diff-size gate at Refine sizes the ticket up:
          </p>
          <ul className="mt-6 space-y-3 text-text-soft">
            <li className="rounded-pipenzo bg-surface p-4 shadow-elevated-sm">
              <span className="font-mono text-accent">
                ≤ {soloPr.maxLines} lines and ≤ {soloPr.maxFiles} files
              </span>{' '}
              → one PR.
            </li>
            <li className="rounded-pipenzo bg-surface p-4 shadow-elevated-sm">
              <span className="font-mono text-accent">
                ≤ {stackedPrs.maxLines} lines and ≤ {stackedPrs.maxFiles} files
              </span>{' '}
              → a dependency-ordered stack of {stackedPrs.minPrs}–{stackedPrs.maxPrs} PRs.
            </li>
            <li className="rounded-pipenzo bg-surface p-4 shadow-elevated-sm">
              <span className="font-mono text-text">Anything above that, or no clean layering</span>{' '}
              → refuse, and hand it to a human with the estimate and a proposed split.
            </li>
          </ul>
          <p className="mt-6 text-text-soft">
            Saying "this ticket's too big" out loud is a feature, not a failure. Refusal is a real
            ticket state, not an error message, so the agent never quietly muddles through
            something it should have handed back to you.
          </p>
        </div>
        <img
          src={oversizedTicket}
          alt="Pipenzo, holding up a hand, declining an oversized ticket rather than attempting it"
          width={1600}
          height={900}
          loading="lazy"
          className="w-full rounded-pipenzo shadow-elevated"
        />
      </Container>
    </section>
  );
}
