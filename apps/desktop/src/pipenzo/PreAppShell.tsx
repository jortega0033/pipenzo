import type { ReactNode } from 'react';
import type { PreAppStep } from './startup-route.js';

/**
 * Connect.dc.html's pre-app frame (issue #113): a 64px topbar carrying the brand and the two-step
 * switcher, over a single centered content column.
 *
 * ## What is missing on purpose
 *
 * No sidebar, no workspace row, no breadcrumb bar, no command palette, no account menu — the
 * canvas states the reason and it is not minimalism: *there is no workspace yet to put in them*.
 * Before a credential exists there is no repo context, no board and nowhere to navigate, so a nav
 * chrome here would be a row of controls that all lead back to this screen.
 *
 * The brand is `.brand`/`.logo-mark`/`.wordmark` — the same three classes and the same 28px mark
 * `Main.dc.html`'s sidebar uses, reused rather than restyled so the two never drift.
 */
export function PreAppShell({
  step,
  canChooseRepos,
  onStepChange,
  children,
}: {
  step: PreAppStep;
  /** Whether step 2 is reachable. See `ConnectStepBar`. */
  canChooseRepos: boolean;
  onStepChange: (step: PreAppStep) => void;
  children: ReactNode;
}) {
  return (
    <div className="preapp">
      <div className="topbar">
        <div className="brand">
          <div className="logo-mark" aria-hidden="true">
            p
          </div>
          <span className="wordmark">pipenzo</span>
        </div>
        <ConnectStepBar step={step} canChooseRepos={canChooseRepos} onStepChange={onStepChange} />
      </div>
      <div className="center">{children}</div>
    </div>
  );
}

/** The literal labels from Connect.dc.html's topbar, including the `·` separators. */
const STEPS: readonly { readonly value: PreAppStep; readonly label: string }[] = [
  { value: 'device-code', label: '1 · Device code' },
  { value: 'choose-repos', label: '2 · Choose repos' },
];

/**
 * The two-step switcher — `.seg`, the same pill the rest of the app uses for Simple/Expert and the
 * filter tabs, with a third interaction model layered on it.
 *
 * ## Why this is `role="group"` and not `role="tablist"`
 *
 * It looks like a tab bar and it is not one. `role="tablist"`/`role="tab"` is a commitment to the
 * ARIA tabs pattern: every tab `aria-controls`-linked to a `role="tabpanel"`, and roving-tabindex
 * keyboard navigation where the arrow keys move between tabs and only the active one is in the Tab
 * order. Claiming the role without implementing the pattern is worse than not claiming it — a
 * screen-reader user is told "tab 1 of 2" and then presses the arrow keys, which do nothing.
 *
 * What this actually is, is a **wizard step indicator**: one thing on screen at a time, moved
 * through in order, not independent parallel panes. `aria-current="step"` is the vocabulary for
 * exactly that, and a plain button group is what carries it. That is also what `Segmented` does.
 *
 * ## Why not `Segmented` itself, then
 *
 * `Segmented` says `aria-pressed`, which means "this toggle is on" — a different statement from
 * "this is the step you are on". And a step here can be *unreachable*: before a credential exists,
 * step 2 is a repo picker with nothing to list, and `Segmented` has no way to express that. The
 * canvas lets both steps be clicked because it is a static preview of both states, which its own
 * inline note says outright; a disabled button is the honest rendering in the product, rather than
 * a click that lands on an empty screen.
 *
 * Going *back* to step 1 stays allowed once step 2 is reachable. The device code is single-use and
 * expiring, so "show me that screen again" is a real request, and the flow that owns it (#114)
 * needs somewhere to return to.
 */
export function ConnectStepBar({
  step,
  canChooseRepos,
  onStepChange,
}: {
  step: PreAppStep;
  canChooseRepos: boolean;
  onStepChange: (step: PreAppStep) => void;
}) {
  return (
    // `.steps` scopes this component's own rules (the disabled step) off the bare `.seg` class the
    // rest of the app shares, so the next `Segmented`-based switch that gains a disabled option
    // does not silently inherit styling written for a different control.
    <div className="seg steps" role="group" aria-label="Connect steps">
      {STEPS.map((option) => {
        const current = option.value === step;
        const disabled = option.value === 'choose-repos' && !canChooseRepos;
        return (
          <button
            key={option.value}
            type="button"
            className={current ? 'active' : undefined}
            {...(current ? { 'aria-current': 'step' as const } : {})}
            disabled={disabled}
            title={disabled ? 'Connect GitHub first — there are no repos to list yet.' : undefined}
            onClick={() => onStepChange(option.value)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * `.pane` — the 620px column each step renders into, with the canvas's `h1`/sub pair above it.
 *
 * Shell-adjacent rather than shell-owned: the frame centres it, but its heading, body and action
 * row all belong to whichever step is showing (#114's device code, #115's repo picker). It lives
 * here so both steps get the same column width, gap and type without either one redefining them.
 */
export function ConnectPane({
  title,
  subtitle,
  actions,
  children,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="pane">
      <div>
        <h1 className="pane-title">{title}</h1>
        {subtitle && <p className="pane-sub">{subtitle}</p>}
      </div>
      {children}
      {actions && <div className="pane-acts">{actions}</div>}
    </div>
  );
}
