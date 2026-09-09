import reviewProcess from '../assets/pipenzo/illustrations/pipenzo-review-process-1600x900.webp';
import { Container } from '../components/Container.js';

/**
 * Drift risk (issue #289): this list is hand-duplicated from README's "Review" bullet and from
 * `content.ts`'s `WORKFLOW_STEPS` Review-phase `summary` -- see that file's own doc comment for
 * why nothing currently checks the three against each other. It already drifted once (`lint`
 * wasn't in any of the three copies until #283 shipped the gate itself).
 */
const GATES = [
  {
    name: 'Deterministic gates',
    detail: 'Build/typecheck, lint, spec-generated tests the implementer never wrote itself, gitleaks, Semgrep, a diff-scope check against the Phase-1 estimate.',
  },
  {
    name: 'LLM reviewer',
    detail: "A fresh session that only ever sees the spec and the diff, never the implementer's own conversation.",
  },
  {
    name: 'Adversarial verifier',
    detail: 'A separate pass, never a weaker model than the implementer, checking the diff against the spec one more time.',
  },
] as const;

export function ReviewBeforeTrust() {
  return (
    <section aria-labelledby="review-heading" className="border-b border-border py-20">
      <Container>
        <h2 id="review-heading" className="text-3xl font-bold text-text">
          Review before trust
        </h2>
        <p className="mt-4 max-w-2xl text-text-soft">
          Every diff earns your trust the same way: three passes, in order, before it ever reaches
          you. The adversarial verifier's verdict is what actually gates the push. The LLM
          reviewer's findings are advisory, so you see them, but they don't hold anything back on
          their own.
        </p>
        <p className="mt-4 max-w-2xl text-text-soft">
          If you've seen the "4 layers of AI code review" framing elsewhere, this is that:
          deterministic hooks automate the obvious, local AI review checks the diff against your
          own stated conventions, and how much of your own attention a change earns scales with its
          risk. A GitHub-side safety net for the reviews you skip locally is next.
        </p>

        <img
          src={reviewProcess}
          alt="Inspector and Auditor reviewing a diff against deterministic gate results"
          width={1600}
          height={900}
          loading="lazy"
          className="mt-10 w-full rounded-pipenzo shadow-elevated"
        />

        <ol className="mt-10 grid gap-6 sm:grid-cols-3">
          {GATES.map((gate, index) => (
            <li key={gate.name} className="rounded-pipenzo bg-surface p-5 shadow-elevated-sm">
              <p className="font-mono text-xs uppercase tracking-wide text-text-faint">
                {index + 1}
              </p>
              <h3 className="mt-1 text-lg font-semibold text-text">{gate.name}</h3>
              <p className="mt-2 text-sm text-text-soft">{gate.detail}</p>
            </li>
          ))}
        </ol>
      </Container>
    </section>
  );
}
