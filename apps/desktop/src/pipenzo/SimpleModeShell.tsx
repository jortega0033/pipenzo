import type { KeyboardEvent, ReactNode } from 'react';
import { Empty } from '../components/primitives/Empty.js';
import { Icon, type IconName } from '../components/primitives/Icon.js';
import { Segmented } from '../components/primitives/Segmented.js';
import { useUiMode } from '../ui-mode.js';

/**
 * `SimpleMode.dc.html`'s own root (issue #133): a 64px topbar carrying the brand and the Simple/
 * Expert switch, over a single centered column -- no `.sidebar`, no workspace row, no breadcrumb
 * bar, no command palette. `PreAppShell.tsx` already made this exact call for the pre-credential
 * screens and its own doc comment gives the reason that also applies here: `PipenzoAppShell`'s
 * `<AppShell sidebar={...}>` wraps every one of its `view`s in the same sidebar unconditionally, so
 * Simple mode cannot be one more case inside that switch without either faking a sidebar the canvas
 * never draws or restructuring the one composition every other view depends on. A sibling top-level
 * shell -- this one -- is what the canvas actually shows, mounted instead of `PipenzoAppShell` by
 * `AppRoot.tsx` while `useUiMode()`'s `mode` reads `'simple'`.
 *
 * `.topbar`/`.center` are already generic, shared layout primitives (`pipenzo-theme.css`'s own
 * comment on `.preapp` says so) reused here unchanged; `.simple-shell`/`.simple-card`/`.link`/
 * `.link-row` are new, added for this ticket -- see that stylesheet's own comment on why `.simple-
 * shell` doesn't reuse `.preapp`'s name for an unrelated (fully authenticated) case.
 *
 * ## What this deliberately does not render
 *
 * `SimpleMode.dc.html`'s own sample also carries the full plain-language card -- before/after
 * screenshots, a prose summary, the checks list, the publish gate -- but that content, and the
 * humanized prose pass behind it, is issues #134-142's own scope (README's build order still lists
 * "the humanizing prose pass" as designed-not-wired-in). Building any of it here would be guessing
 * at a content layer this ticket was never asked for; `activeTicket` carries only the one real
 * identity fact (`ticketId`/`issueNumber`, plus the title the board already has) needed to make the
 * two crossover links real, and nothing else.
 *
 * ## The honest gap (issue #151, #129)
 *
 * `activeTicket` is `undefined` until something calls into Simple mode naming a real ticket -- the
 * tray badge (#151) or a notification (#129), both still open. Rather than guess that wiring, this
 * renders the plain, honest empty state below instead of a fabricated ticket.
 */
export function SimpleModeShell({
  activeTicket,
  onOpenTechnicalDetails,
}: {
  /** The one ticket Simple mode is currently showing, or `undefined` while nothing has routed one
   * in yet (see "The honest gap" above). */
  activeTicket?: { ticketId: string; issueNumber: number; title?: string };
  /** Reports the ticket id upward rather than deciding navigation itself -- the same
   * "reporting, not deciding" shape `ActivityRow.tsx`'s `onOpenTicket` and
   * `TicketSwitcherPanel.tsx`'s `onSwitch` already use. `AppRoot.tsx` is what turns this into an
   * actual switch to Expert mode, landed on this exact ticket's `TicketDetailContainer`. */
  onOpenTechnicalDetails: (ticketId: string) => void;
}) {
  const { mode, setMode } = useUiMode();

  return (
    <div className="simple-shell">
      <div className="topbar">
        <div className="brand">
          <div className="logo-mark" aria-hidden="true">
            p
          </div>
          <span className="wordmark">pipenzo</span>
        </div>
        <Segmented
          aria-label="Simple or Expert mode"
          value={mode}
          onChange={setMode}
          options={[
            { value: 'simple', label: 'Simple' },
            { value: 'expert', label: 'Expert' },
          ]}
        />
      </div>
      <div className="center">
        <div className="simple-card">
          {activeTicket ? (
            <>
              <p className="mono">#{activeTicket.issueNumber}</p>
              <h1 className="pane-title">{activeTicket.title ?? `Issue #${activeTicket.issueNumber}`}</h1>
              <div className="link-row">
                {/*
                 * "Ask a follow-up" (issue #133): the canvas draws this as a plain `.link` with no
                 * destination of its own -- it is not the "Send it back" decline flow's own reason
                 * textarea (a different control, a few artboards over), and nothing in the canvas or
                 * this issue names a backend for a free-form follow-up question yet. Left genuinely
                 * inert (no `onClick`, `aria-disabled`) rather than guessed at, the same "the canvas
                 * gives this control no handler at all" treatment `PipenzoAppShell.tsx`'s own held-
                 * card "Run anyway" button already applies to an affordance it has no real capability
                 * behind.
                 */}
                <CrossoverLink icon="message">Ask a follow-up</CrossoverLink>
                <CrossoverLink
                  icon="code"
                  onClick={() => onOpenTechnicalDetails(activeTicket.ticketId)}
                >
                  See the technical details
                </CrossoverLink>
              </div>
            </>
          ) : (
            <Empty title="Nothing to show in Simple mode yet">
              A tray-badge or notification click will land a ticket here once those exist to send
              one -- both are still open tickets (#151, #129), so there is nothing routed in yet.
            </Empty>
          )}
        </div>
      </div>
    </div>
  );
}

/** `.link` -- an icon-plus-label crossover action, distinct from both `.btn` and the plainer
 * text-only `RLink` (`.r-link`): the canvas's own two crossover links use this exact class. Present
 * but non-interactive when `onClick` is omitted -- no `tabIndex`, no `role`, `aria-disabled` --
 * rather than a click that does nothing, matching every other inert-by-design control in this app. */
function CrossoverLink({
  icon,
  onClick,
  children,
}: {
  icon: IconName;
  onClick?: () => void;
  children: ReactNode;
}) {
  const onKeyDown = (event: KeyboardEvent<HTMLSpanElement>) => {
    if (!onClick) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onClick();
    }
  };

  return (
    <span
      className="link"
      tabIndex={onClick ? 0 : undefined}
      role={onClick ? 'button' : undefined}
      aria-disabled={onClick ? undefined : true}
      onClick={onClick}
      onKeyDown={onKeyDown}
    >
      <Icon name={icon} />
      {children}
    </span>
  );
}
