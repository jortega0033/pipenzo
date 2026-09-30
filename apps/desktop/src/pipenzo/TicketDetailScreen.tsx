import type { ReactNode } from 'react';

/**
 * The TicketDetail screen's own shell (issue #90): `TicketDetail.dc.html`'s `.header` (id, title,
 * stepper row, run-controls slot) and `.body` grid -- centre `.stream` on the left, `.rail` on the
 * right, its four blocks fixed in the canvas's own top-to-bottom order: Status, Cumulative risk,
 * Model routing, Subscription headroom.
 *
 * Every piece inside it is a slot, not content built here -- the same deferral `BoardScreen.tsx`'s
 * own doc comment already established for `renderTicket`. The phase stepper is #91, the "Needs
 * you" ticket switcher is #92, live run controls (Steer/Stop) are #103, the activity stream is
 * #93, and the four rail blocks are #94-#96 (see `RailBlock.tsx`). Guessing at any of their
 * content here would be exactly the frame-guessing `BoardScreen.tsx` warns against for its own
 * lane cards -- this file only has to prove the frame those tickets drop into is real.
 *
 * Slots into `AppShell`'s `.main`, under its own `MainHead` -- neither built here, for the same
 * reason `BoardScreen.tsx`'s own doc comment gives: the nav that mounts this screen and the header
 * above it belong to the shell-wiring ticket (#341), not to the screen itself.
 *
 * `lessonPrompt` (issue #104) is the same kind of slot: `LessonPrompt` (`TicketDetail.dc.html`'s
 * `.lesson`), placed at the foot of the stream once a caller's own ticket-resolved signal fires --
 * this shell only reserves where it renders, the same deferral every other slot here already gets.
 */
export function TicketDetailScreen({
  ticketId,
  title,
  stepper,
  ticketSwitcher,
  runControls,
  statusBlock,
  riskBlock,
  modelRoutingBlock,
  headroomBlock,
  lessonPrompt,
  children,
}: {
  /** e.g. `"#94"` -- `.h-id`, matching `TicketDetail.dc.html`'s `{{tId}}`. */
  ticketId: ReactNode;
  title: ReactNode;
  /** The phase stepper (#91), the step row's left half. */
  stepper?: ReactNode;
  /** The "Needs you" ticket switcher (#92), the step row's right half. Neither half renders a
   * `.step-row` at all until at least one of them is supplied. */
  ticketSwitcher?: ReactNode;
  /** Live run controls (#103) -- `RunControls`, meant to render only while a phase is genuinely
   * running; see `RunControls.tsx`'s own "no absent state" note. Omitted renders nothing. */
  runControls?: ReactNode;
  /** The rail's four blocks, fixed in `TicketDetail.dc.html`'s own order -- each expected to be a
   * `RailBlock`, or omitted while its own ticket (#94-#96) hasn't landed yet. */
  statusBlock?: ReactNode;
  riskBlock?: ReactNode;
  modelRoutingBlock?: ReactNode;
  headroomBlock?: ReactNode;
  /** The centre activity stream's own content (#93). */
  children?: ReactNode;
  /** `LessonPrompt`, or omitted before the ticket has resolved (or when #93's own activity stream
   *  handles it inline instead -- either is a caller decision, not this shell's). */
  lessonPrompt?: ReactNode;
}) {
  return (
    <>
      <div className="header">
        <span className="h-id">{ticketId}</span>
        <span className="h-title">{title}</span>
        {(stepper || ticketSwitcher) && (
          <div className="step-row">
            {stepper}
            {ticketSwitcher}
          </div>
        )}
        {runControls}
      </div>
      <div className="body">
        <div className="stream">
          {children}
          {lessonPrompt}
        </div>
        <div className="rail">
          {statusBlock}
          {riskBlock}
          {modelRoutingBlock}
          {headroomBlock}
        </div>
      </div>
    </>
  );
}
