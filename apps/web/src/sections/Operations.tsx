import commanderRouting from '../assets/pipenzo/mascot/detailed/pipenzo-commander-routing.webp';
import { Container } from '../components/Container.js';

const RESPONSIBILITIES = [
  'Model routing: a routing class (refine / implement-small / implement-standard / implement-hard / review / verify) maps to a model tier (cheap / mid / frontier).',
  "Retries: a same-tier retry forks the session; a tier escalation starts a fresh one, since the model tier is frozen into a fork's continuation scope and can't change mid-fork.",
  'Queue and work coordination: every concurrent ticket gets its own worktree and branch, never shared.',
  'Decomposition: an oversized ticket that refuses at the diff-size gate gets a proposed split, not a silent oversized PR.',
] as const;

/**
 * Commander is operations/orchestration mode, not the hero (#245: "Commander should not replace
 * the canonical Field Engineer in the hero" -- the hero uses Field Engineer; Commander appears
 * only here, where the section is actually about routing/coordination).
 */
export function Operations() {
  return (
    <section aria-labelledby="operations-heading" className="border-b border-border py-20">
      <Container className="grid items-center gap-12 lg:grid-cols-2">
        <img
          src={commanderRouting}
          alt="Commander, coordinating multiple concurrent tickets"
          width={1536}
          height={1536}
          loading="lazy"
          className="mx-auto w-full max-w-sm rounded-pipenzo shadow-elevated lg:order-2"
        />
        <div>
          <h2 id="operations-heading" className="text-3xl font-bold text-text">
            Operations and routing
          </h2>
          <p className="mt-4 text-text-soft">
            Meet Commander: same operator, different loadout. When more than one ticket is in
            flight, Commander is the one keeping routing, retries, and coordination straight.
          </p>
          <ul className="mt-6 space-y-3">
            {RESPONSIBILITIES.map((item) => (
              <li key={item} className="rounded-pipenzo bg-surface p-4 text-sm text-text-soft shadow-elevated-sm">
                {item}
              </li>
            ))}
          </ul>
        </div>
      </Container>
    </section>
  );
}
