import reconRefine from '../assets/pipenzo/mascot/detailed/pipenzo-recon-refine.webp';
import fieldEngineerWorking from '../assets/pipenzo/mascot/detailed/pipenzo-field-engineer-working.webp';
import inspectorReview from '../assets/pipenzo/mascot/detailed/pipenzo-inspector-review.webp';
import auditorVerify from '../assets/pipenzo/mascot/detailed/pipenzo-auditor-verify.webp';
import readyWaiting from '../assets/pipenzo/mascot/mini/pipenzo-head-waiting-96.webp';
import { Container } from '../components/Container.js';
import { WORKFLOW_STEPS } from '../content.js';

const PORTRAITS: Record<(typeof WORKFLOW_STEPS)[number]['role'], string> = {
  recon: reconRefine,
  engineer: fieldEngineerWorking,
  inspector: inspectorReview,
  auditor: auditorVerify,
  ready: readyWaiting,
};

export function HowItWorks() {
  return (
    <section id="how-it-works" aria-labelledby="how-it-works-heading" className="border-b border-border py-20">
      <Container>
        <h2 id="how-it-works-heading" className="text-3xl font-bold text-text">
          How it works
        </h2>
        <p className="mt-3 max-w-2xl text-text-soft">
          Four automated phases the agent runs inside its own boundary, then one step that isn't
          automated at all.
        </p>

        <ol className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-5">
          {WORKFLOW_STEPS.map((step, index) => {
            const isLast = index === WORKFLOW_STEPS.length - 1;
            return (
              <li
                key={step.phase}
                className={`rounded-pipenzo p-5 shadow-elevated-sm ${
                  isLast ? 'bg-surface-2 shadow-[inset_2px_0_0_var(--color-accent)]' : 'bg-surface'
                }`}
              >
                <img
                  src={PORTRAITS[step.role]}
                  alt=""
                  aria-hidden="true"
                  width={64}
                  height={64}
                  loading="lazy"
                  className="h-16 w-16 rounded-full object-cover"
                />
                <p className="mt-4 font-mono text-xs uppercase tracking-wide text-text-faint">
                  {index + 1}. {isLast ? 'Human decision' : 'Automated'}
                </p>
                <h3 className={`mt-1 text-lg font-semibold ${isLast ? 'text-accent' : 'text-text'}`}>
                  {step.phase}
                </h3>
                <p className="mt-2 text-sm text-text-soft">{step.summary}</p>
              </li>
            );
          })}
        </ol>
      </Container>
    </section>
  );
}
