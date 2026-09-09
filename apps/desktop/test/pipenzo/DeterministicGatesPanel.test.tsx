import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DETERMINISTIC_GATE_IDS } from '@agent-dock/shared';
import { DeterministicGatesPanel } from '../../src/pipenzo/DeterministicGatesPanel.js';
import { GATE_CATALOGUE, catalogueCoverage } from '../../src/pipenzo/gate-catalog.js';

/**
 * Issue #123, against Models.dc.html's "Deterministic gates — the hard, non-negotiable set".
 *
 * The panel's whole content is a negative — there is nothing here to configure — so the tests are
 * mostly about that negative being real rather than merely rendered.
 */

describe('gate catalogue', () => {
  /**
   * Models.dc.html shows five rows; `DETERMINISTIC_GATE_IDS` has seven ids (issue #283 added
   * `lint` as a third id folded into the first row). That is deliberate and the artboard says so
   * ("the same five, grouped for reading rather than for configuring") -- `build`, `typecheck` and
   * `lint` read as one thing and stay three ids because the runner reports them separately.
   */
  it('groups the seven gate ids into the five rows the canvas shows', () => {
    expect(GATE_CATALOGUE).toHaveLength(5);
    expect(DETERMINISTIC_GATE_IDS).toHaveLength(7);
    expect(GATE_CATALOGUE[0]?.ids).toEqual(['build', 'typecheck', 'lint']);
  });

  /**
   * A panel that renders "the hard, non-negotiable set" while quietly omitting one of it is worse
   * than no panel, and a new gate id is exactly the change that would cause it.
   */
  it('covers every deterministic gate exactly once, with nothing invented', () => {
    expect(catalogueCoverage()).toEqual({ missing: [], duplicated: [], unknown: [] });
  });
});

describe('DeterministicGatesPanel', () => {
  it('renders one row per catalogue entry, in the runner’s own order', () => {
    const { container } = render(<DeterministicGatesPanel />);
    const names = [...container.querySelectorAll('.gate-name')];
    expect(names.map((el) => el.textContent)).toEqual([
      'Build, typecheck and lint',
      'Spec-generated tests',
      'gitleaks',
      'Semgrep',
      'Diff-scope check',
    ]);
  });

  /**
   * README's rule is that the deterministic set is non-negotiable. A settings screen that merely
   * *omitted* an off switch would leave a reader wondering where it was; a locked switch says
   * "this is not a decision you have".
   */
  it('renders every gate as an on, locked, disabled switch labelled always on', () => {
    const { container } = render(<DeterministicGatesPanel />);
    const switches = screen.getAllByRole('switch');
    expect(switches).toHaveLength(5);
    for (const control of switches) {
      expect(control).toBeDisabled();
      expect(control).toHaveAttribute('aria-checked', 'true');
      expect(control.className).toContain('on');
    }
    expect(container.querySelectorAll('.gate-lock')).toHaveLength(5);
    expect(screen.getAllByText('always on')).toHaveLength(5);
  });

  /**
   * The stronger form of the same claim: there is no parameter through which a caller could make
   * these toggles do anything, so "no configuration turns one off" is a property of the
   * component's signature rather than of its current implementation.
   */
  it('accepts no props at all, so a caller cannot wire an off switch to it', () => {
    expect(DeterministicGatesPanel.length).toBe(0);
  });

  /** Issue #146's rule, stated where somebody configuring the system will read it. */
  it('states the test-wrong / code-wrong adjudication rule', () => {
    render(<DeterministicGatesPanel />);
    const rule = screen.getByText(/A failing spec-generated test is not automatically/);
    const row = rule.closest('.gate-sub');
    expect(row?.textContent).toContain('adjudicated once, by the verifier tier');
    expect(row?.textContent).toContain('never silently deleted');
    expect(row?.textContent).toContain('visible in the PR body');
  });

  /** Issue #145's rule, in the same place. */
  it('states that the diff-scope check measures implementation files only', () => {
    render(<DeterministicGatesPanel />);
    const rule = screen.getByText(/The diff-scope check measures implementation files only/);
    expect(rule.closest('.gate-sub')?.textContent).toContain(
      'counted and reported separately',
    );
  });

  /**
   * Issue #283: lint joined the deterministic set, folded into the build/typecheck row rather than
   * a new one -- the help text must say why they're grouped, not (as it used to) claim lint is not
   * one of pipenzo's gates at all.
   */
  it('explains why build, typecheck and lint share one row', () => {
    const { container } = render(<DeterministicGatesPanel />);
    const help = container.querySelector('.f-help');
    expect(help?.textContent).toContain('Build, typecheck and lint report as one row');
    expect(help?.textContent).not.toContain('never appears in the gate count');
    expect(help?.textContent).not.toContain('not one of');
  });
});
