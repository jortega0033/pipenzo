import { Fieldset } from '../components/primitives/Fieldset.js';
import { Toggle } from '../components/primitives/Toggle.js';
import { GATE_CATALOGUE, GATE_HONESTY_RULES } from './gate-catalog.js';

/**
 * The Models & gates screen's deterministic-gate panel (issue #123) — Models.dc.html's
 * "Deterministic gates — the hard, non-negotiable set" section.
 *
 * The whole point of the panel is a *negative*: there is nothing here to configure. Every gate
 * renders as a switch that is on, locked and disabled, with an "always on" label beside it,
 * because README's rule is that the deterministic set is non-negotiable and a settings screen that
 * merely *omitted* the off switch would leave a reader wondering where it was. A locked switch
 * says "this is not a decision you have" in a way an absent switch does not.
 *
 * Two things it deliberately does not do:
 *
 * - **It does not accept an `onChange`.** Not a disabled prop, not an ignored callback — there is
 *   no parameter through which a caller could make these toggles do something. The claim "there is
 *   no configuration that turns one off" is then a property of the component's signature rather
 *   than of its current implementation.
 * - **It does not hardcode the gate list.** Rows come from `GATE_CATALOGUE`, which is derived from
 *   `DETERMINISTIC_GATE_IDS`, so a seventh gate cannot land without this panel either showing it
 *   or failing `catalogueCoverage()`.
 */
export function DeterministicGatesPanel() {
  return (
    <section className="gates-panel">
      <h2>Deterministic gates — the hard, non-negotiable set</h2>
      <p className="sec-note">
        These five run first, on this machine, and either pass or block the ticket. Only after all
        five pass does the LLM review pass run, in a fresh session seeing just the spec and the
        diff, followed by the separate adversarial verifier. There is no configuration that turns
        one off — which is why they render as switches you can read but not move.
      </p>

      <div className="form-panel">
        <Fieldset label="Machine-verified">
          {GATE_CATALOGUE.map((row) => (
            <div className="gate-row" key={row.key}>
              <span className="gate-text">
                <span className="gate-name">{row.name}</span>
                <span className="gate-sub">{row.description}</span>
              </span>
              <span className="gate-ctl">
                <span className="gate-lock">always on</span>
                <Toggle
                  checked
                  locked
                  onChange={() => undefined}
                  aria-label={`${row.name} — always on, not configurable`}
                />
              </span>
            </div>
          ))}
        </Fieldset>
        <span className="f-help">
          In the diff view these render as the <b>Machine-verified</b> block, where gitleaks and
          Semgrep report on one line — the same five, grouped for reading rather than for
          configuring. Nothing else joins that block: a repo’s own lint runs in its CI and can move
          a ticket to <span className="mono">pipenzo:ci-failed</span>, but it is not one of
          pipenzo’s gates and never appears in the gate count.
        </span>
      </div>

      <div className="form-panel">
        <Fieldset label="Two rules that keep the test gate honest">
          {GATE_HONESTY_RULES.map((rule) => (
            <span className="gate-sub" key={rule.lead}>
              <b>{rule.lead}</b> {rule.body}
            </span>
          ))}
        </Fieldset>
      </div>
    </section>
  );
}
