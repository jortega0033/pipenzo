import inspector from '../assets/pipenzo/web/inspector-review.webp';
import { Container } from '../components/Container.js';
import { SectionHeading } from '../components/SectionHeading.js';

/**
 * Plain-language passes only. The named check list, pass-to-phase mapping, and model rules live in
 * README.md ("How it works", step 4), which stays the source of truth.
 *
 * The wording stays modest about what each pass enforces: a failed automated check does end the
 * chain (`review-gates.ts` returns before either AI pass is built), but no review outcome is an
 * input to `publish-service.ts` today, so nothing here claims to block the push. Only the human
 * approval click does that.
 */
const PASSES = [
  {
    name: 'Automated checks',
    advisory: false,
    detail:
      'The change has to build, pass tests written from the spec, and clear a set of quality and security checks. If any of them fails, the chain stops here.',
  },
  {
    name: 'A fresh-eyes review',
    advisory: true,
    detail:
      'A second AI session reviews the change. It only sees the spec and the code, never the conversation that wrote it.',
  },
  {
    name: 'A skeptical second look',
    advisory: false,
    detail:
      'A third, separate session checks the change against the spec once more, looking for a reason to reject it.',
  },
] as const;

/**
 * The review chain as a literal diagram: one spine, three passes in order, then the human. The
 * advisory pass is drawn dashed and hangs its notes off to the side, because they reach you
 * without holding the change back. Built in HTML so every label is real, selectable text.
 */
export function ReviewBeforeTrust() {
  return (
    <section
      id="review"
      aria-labelledby="review-heading"
      className="border-b border-border py-24 sm:py-28"
    >
      <Container className="grid grid-cols-1 gap-14 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] lg:gap-16">
        <div>
          <SectionHeading
            index="04"
            label="review + verify"
            id="review-heading"
            title="Review and verify"
          >
            <p>
              Every change goes through automated checks. Then a second AI session reviews it with
              fresh eyes, and a third one checks it again, looking for a reason to reject it.
            </p>
            <p>
              None of those passes can ship your code. The reviewer's findings are advice, and
              the final verdict is something you read before you decide. Only your approval sends
              a change out.
            </p>
          </SectionHeading>
          <img
            src={inspector}
            alt=""
            aria-hidden="true"
            width={560}
            height={731}
            loading="lazy"
            className="mx-auto mt-12 hidden w-[62%] max-w-xs drop-shadow-[0_20px_36px_rgba(0,0,0,0.5)] lg:block"
          />
        </div>

        <div className="relative">
          <div className="rounded-pipenzo border border-border bg-surface p-5 shadow-elevated sm:p-7">
            <p className="flex items-center gap-2 font-mono text-xs text-text-faint">
              <span className="rounded-pipenzo-sm bg-surface-3 px-2 py-1 text-text-soft">
                the finished change
              </span>
              <span aria-hidden="true">↓</span>
            </p>

            <div className="relative mt-4">
              {/* Spine */}
              <div
                className="absolute bottom-6 left-[15px] top-6 w-[2px] bg-surface-4"
                aria-hidden="true"
              />
              <ol className="relative space-y-4">
                {PASSES.map((pass, index) => (
                  <li
                    key={pass.name}
                    className="relative grid grid-cols-[32px_minmax(0,1fr)] gap-4"
                  >
                    <span
                      className={`relative z-10 mt-4 flex h-8 w-8 items-center justify-center rounded-full font-mono text-xs font-semibold ${
                        pass.advisory
                          ? 'border-2 border-dashed border-text-faint bg-surface text-text-faint'
                          : 'bg-accent text-accent-fg'
                      }`}
                      aria-hidden="true"
                    >
                      {index + 1}
                    </span>
                    <div
                      className={`rounded-pipenzo p-4 sm:p-5 ${
                        pass.advisory
                          ? 'border border-dashed border-surface-4 bg-transparent'
                          : 'border border-border bg-surface-2'
                      }`}
                    >
                      <h3 className="text-lg font-semibold text-text">{pass.name}</h3>
                      <p className="mt-2 text-sm leading-relaxed text-text-soft">{pass.detail}</p>
                      {pass.advisory ? (
                        <p className="mt-3 flex items-center gap-2 font-mono text-xs text-text-faint">
                          <span className="dash-h h-px w-8 shrink-0" aria-hidden="true" />
                          advice only, it never holds the change back
                        </p>
                      ) : null}
                      {index === PASSES.length - 1 ? (
                        <p className="mt-3 font-mono text-xs text-accent">
                          its verdict is shown to you before you decide
                        </p>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ol>
            </div>

            <div className="mt-4 grid grid-cols-[32px_minmax(0,1fr)] gap-4">
              <span
                className="flex h-8 w-8 items-center justify-center rounded-full border-2 border-warn text-warn"
                aria-hidden="true"
              >
                <svg
                  viewBox="0 0 16 16"
                  className="h-4 w-4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.6}
                >
                  <circle cx="8" cy="5.5" r="2.5" />
                  <path d="M3 14c0-2.8 2.2-4.8 5-4.8s5 2 5 4.8" strokeLinecap="round" />
                </svg>
              </span>
              <p className="rounded-pipenzo border border-warn/40 bg-surface-2 px-4 py-3 text-sm text-text-soft">
                <span className="font-semibold text-text">Then you.</span> The change, the final
                verdict, and everything the passes found wait for your explicit approval. That click
                is what gates the push.
              </p>
            </div>
          </div>
        </div>
      </Container>
    </section>
  );
}
