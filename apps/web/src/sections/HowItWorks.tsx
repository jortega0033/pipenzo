import waitingHead from '../assets/pipenzo/mascot/mini/pipenzo-head-waiting-96.webp';
import { Container } from '../components/Container.js';
import { PhaseGlyph } from '../components/PhaseGlyph.js';
import { SectionHeading } from '../components/SectionHeading.js';
import { PHASE_TAGS, WORKFLOW_STEPS } from '../content.js';
import { useSeenOnce } from '../hooks/motion.js';

const AUTOMATED = WORKFLOW_STEPS.slice(0, -1);
const HUMAN = WORKFLOW_STEPS[WORKFLOW_STEPS.length - 1]!;

/**
 * The pipeline drawn the way it actually runs: four automated stations on one rail, then a
 * boundary, then a step that belongs to a person. The rail stops at the wall on purpose. The
 * human gate is a different object (bordered, not on the rail) because it is a different kind
 * of step.
 */
export function HowItWorks() {
  const [ref, seen] = useSeenOnce<HTMLDivElement>();

  return (
    <section
      id="how-it-works"
      aria-labelledby="how-it-works-heading"
      className="border-b border-border py-24 sm:py-28"
    >
      <Container>
        <SectionHeading
          index="01"
          label="pipeline"
          id="how-it-works-heading"
          title="Four automated phases, then a decision only you can make."
        >
          <p>
            Each phase is its own session with its own job, and each hands the next one something
            concrete. The agent runs inside its boundary until the diff is verified. What happens
            after that is your call alone.
          </p>
        </SectionHeading>

        <div ref={ref} className={`mt-16 ${seen ? 'is-live' : ''}`}>
          <div className="grid gap-10 lg:grid-cols-[minmax(0,4fr)_auto_minmax(0,1.15fr)] lg:gap-0">
            {/* Automated stations */}
            <div>
              <p className="eyebrow mb-6 flex items-center gap-3">
                <span className="h-2 w-2 rounded-full bg-accent" aria-hidden="true" />
                Inside the agent boundary · automated
              </p>
              <div className="relative">
                <div
                  className="rail rail-v left-[27px] top-4 bottom-4 lg:hidden"
                  aria-hidden="true"
                />
                <div
                  className="rail rail-h left-4 right-0 top-[27px] hidden lg:block"
                  aria-hidden="true"
                />
                <ol className="relative grid gap-8 lg:grid-cols-4 lg:gap-5">
                  {AUTOMATED.map((step, index) => (
                    <li
                      key={step.phase}
                      className="relative grid grid-cols-[56px_1fr] gap-x-5 lg:block"
                    >
                      <div className="relative z-10 flex h-14 w-14 items-center justify-center rounded-pipenzo border border-surface-4 bg-surface-2 text-accent shadow-elevated-sm">
                        <PhaseGlyph role={step.role} className="h-7 w-7" />
                      </div>
                      <div className="lg:mt-6 lg:pr-3">
                        <p className="font-mono text-xs text-text-faint">
                          {String(index + 1).padStart(2, '0')} · {PHASE_TAGS[step.role]}
                        </p>
                        <h3 className="mt-1.5 text-xl font-semibold text-text">{step.phase}</h3>
                        <p className="mt-2 text-[0.9375rem] leading-relaxed text-text-soft">
                          {step.summary}
                        </p>
                      </div>
                    </li>
                  ))}
                </ol>
              </div>
            </div>

            {/* The boundary itself */}
            <div
              className="flex items-center gap-4 lg:mx-8 lg:flex-col lg:gap-3"
              aria-hidden="true"
            >
              <div className="boundary-wall h-[2px] flex-1 [--wall-dir:to_right] lg:h-auto lg:w-[2px] lg:[--wall-dir:to_bottom]" />
              <span className="font-mono text-[0.6875rem] uppercase tracking-[0.12em] text-text-faint lg:[writing-mode:vertical-rl]">
                agent stops here
              </span>
              <div className="boundary-wall h-[2px] flex-1 [--wall-dir:to_right] lg:h-auto lg:w-[2px] lg:[--wall-dir:to_bottom]" />
            </div>

            {/* The human gate */}
            <div>
              <p className="eyebrow mb-6 flex items-center gap-3">
                <span className="h-2 w-2 rounded-full bg-warn" aria-hidden="true" />
                Outside it · you
              </p>
              <ol start={WORKFLOW_STEPS.length} className="list-none">
                <li className="rounded-pipenzo border border-accent/60 bg-surface-2 p-6 shadow-elevated">
                  <div className="flex items-center justify-between gap-4">
                    <div className="flex h-14 w-14 items-center justify-center rounded-full border border-accent/60 text-accent">
                      <PhaseGlyph role={HUMAN.role} className="h-7 w-7" />
                    </div>
                    <div className="flex items-center gap-2.5">
                      <img
                        src={waitingHead}
                        alt=""
                        aria-hidden="true"
                        width={96}
                        height={96}
                        loading="lazy"
                        className="h-10 w-10 rounded-full bg-surface-3"
                      />
                      <span className="font-mono text-[0.6875rem] leading-tight text-text-faint">
                        Pipenzo
                        <br />
                        waits here
                      </span>
                    </div>
                  </div>
                  <p className="mt-6 font-mono text-xs text-text-faint">
                    05 · {PHASE_TAGS[HUMAN.role]}
                  </p>
                  <h3 className="mt-1.5 text-xl font-semibold text-accent">{HUMAN.phase}</h3>
                  <p className="mt-2 text-[0.9375rem] leading-relaxed text-text-soft">
                    {HUMAN.summary}
                  </p>
                </li>
              </ol>
            </div>
          </div>
        </div>
      </Container>
    </section>
  );
}
