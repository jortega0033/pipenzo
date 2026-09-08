import approvalBoundary from '../assets/pipenzo/illustrations/pipenzo-human-approval-boundary-1600x900.webp';
import { Container } from '../components/Container.js';

/**
 * The page's visual climax (#245): work is complete, Pipenzo stands beside the final control,
 * hands off it, and waits.
 *
 * The image fills the section as an absolutely-positioned background (object-cover) and the text
 * sits in normal document flow on top of it, rather than the text itself being absolutely
 * positioned against the image's own 16:9 aspect ratio -- that first draft clipped the paragraph
 * at narrow viewports, where a 16:9 box at full width is too short to hold five lines of text.
 * `min-h-*` keeps the section tall enough for the image to read as a real backdrop at every width;
 * flow content decides the section's actual height above that floor.
 */
export function HumanBoundary() {
  return (
    <section
      aria-labelledby="human-boundary-heading"
      className="relative min-h-[420px] overflow-hidden border-b border-border sm:min-h-[520px]"
    >
      <img
        src={approvalBoundary}
        alt="Pipenzo standing beside the final publish control, tools packed away, waiting"
        width={1600}
        height={900}
        loading="lazy"
        className="absolute inset-0 h-full w-full object-cover"
      />
      <div className="absolute inset-0 bg-gradient-to-t from-bg via-bg/70 to-bg/10" aria-hidden="true" />
      <Container className="relative flex min-h-[420px] flex-col justify-end py-12 sm:min-h-[520px]">
        <h2 id="human-boundary-heading" className="max-w-xl text-3xl font-bold text-text sm:text-4xl">
          The write capability never reaches the agent.
        </h2>
        <p className="mt-4 max-w-xl text-text-soft">
          <code className="rounded bg-surface px-1.5 py-0.5 font-mono text-sm text-text">
            apps/daemon/src/publish-service.ts
          </code>{' '}
          is the only code in the repo that can call <code className="font-mono">git push</code> or
          open a pull request. It runs daemon-side, behind its own route, with a dedicated test
          asserting the GitHub token can never reach an agent-callable path. That's a property this
          repo has built, not a policy the agent is asked to respect.
        </p>
      </Container>
    </section>
  );
}
