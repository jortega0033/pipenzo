import commanderRouting from '../assets/pipenzo/web/commander-routing.webp';
import operationsMapBg from '../assets/pipenzo/web/operations-map-bg.webp';
import { Container } from '../components/Container.js';
import { SectionHeading } from '../components/SectionHeading.js';

/**
 * Deliberately light: routing, retries, and multi-ticket coordination are designed but not built,
 * so this section carries a short status note and no breakdown. The routing classes, model tiers,
 * and retry rules live in README.md ("Model routing", "Designed, not wired in yet"). Sources for
 * the "today" sentence: `implement-orchestrator.ts` ("No retry ladder. One attempt.") and README's
 * per-ticket worktree/branch rule.
 *
 * Commander is operations/orchestration mode, not the hero (#245: "Commander should not replace
 * the canonical Field Engineer in the hero"). Commander appears only here.
 */
export function Operations() {
  return (
    <section
      aria-labelledby="operations-heading"
      className="relative border-b border-border py-24 sm:py-28"
    >
      <img
        src={operationsMapBg}
        alt=""
        aria-hidden="true"
        className="section-bg-fade pointer-events-none absolute inset-0 h-full w-full object-cover opacity-[0.14]"
      />
      <Container className="relative grid items-start gap-14 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)] lg:gap-16">
        <div>
          <SectionHeading
            index="05"
            label="operations"
            id="operations-heading"
            title="Operations and routing"
          >
            <p>
              Meet Commander: same operator, different loadout. Commander's job will be matching
              each piece of work to a model that suits it, retrying attempts that fail, and running
              several tickets side by side.
            </p>
          </SectionHeading>

          <div className="mt-10 rounded-pipenzo border border-dashed border-surface-4 bg-transparent p-5 sm:p-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h3 className="text-lg font-semibold text-text">Where it stands</h3>
              <span className="chip chip-outline">planned</span>
            </div>
            <p className="mt-2 text-sm leading-relaxed text-text-soft">
              This part is designed and not built yet. Today each ticket gets one attempt, working
              in its own branch that no other ticket shares.
            </p>
          </div>
        </div>

        <img
          src={commanderRouting}
          alt="In a helmet with a headset and a radio pack, pointing ahead with one hand and holding a tablet with a route map and a checklist in the other"
          width={640}
          height={794}
          loading="lazy"
          className="mx-auto w-2/3 max-w-sm drop-shadow-[0_20px_36px_rgba(0,0,0,0.5)] lg:sticky lg:top-28 lg:w-full"
        />
      </Container>
    </section>
  );
}
