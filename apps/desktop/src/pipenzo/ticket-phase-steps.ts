import type { PipenzoLabelV1, PipenzoTicketViewV1 } from '@agent-dock/shared';
import type { StepSpec, StepStatus } from '../components/primitives/PhaseStepper.js';

/**
 * Binds `PhaseStepper.tsx` (issue #64's presentational primitive) to real phase-machine ticket
 * data (issue #91, split of epic #3) -- a pure mapping from `PipenzoTicketViewV1` to the `StepSpec[]`
 * that component already renders, plus the optional trailing hint. No mocked phase data: every
 * branch below reads only `lane`, `phase`, `labels` and `worktree`, the fields the daemon's phase
 * machine (`apps/daemon/src/pipenzo-phase-machine.ts`) actually reconciles from GitHub.
 *
 * The standard run is five steps -- Refine, Plan review, Implement, Review, Publish -- matching
 * `PhaseStepper.tsx`'s own doc comment, with a sixth `ci` step appended only when the ticket carries
 * `pipenzo:ci-failed` (README: the label stays on the ticket through its whole ci-failed lifecycle,
 * so its presence is exactly "CI results exist for this ticket").
 *
 * ## Why there is no dedicated "plan review pending" label to read (issue #15)
 *
 * `pipenzo-ticket-v1.ts`'s own comment on `PIPENZO_PHASES` states that "Approve" (there, the
 * publish gate) is not a distinct phase because `lane: 'ready-for-review'` already says a human is
 * being waited on. README's diff-size gate stops an oversized or underspecified ticket at Refine and
 * asks a human under `pipenzo:needs-pre-scoping` (`refine-gate.ts`'s `refuse` verdict) or
 * `pipenzo:awaiting-stack-approval` (its `stack` verdict) -- but a ticket that clears Refine outright
 * (the `single` verdict) now also stops, under the bare `pipenzo:needs-human` label rather than a
 * third dedicated one: `design/artboards/TicketDetail.dc.html`'s own plan-review mockup is explicit
 * that inventing a label the published set does not name would be exactly the thing CLAUDE.md hard
 * rule #5 refuses. `ticket.planReview` -- populated only when the ticket's local `awaitingPlanReview`
 * marker is set and its cached `spec` survived (`routes/pipenzo-tickets.ts`'s `toTicketView()`) -- is
 * the real signal this module reads instead of a label for that third case.
 */

export type TicketPhaseStepId = 'refine' | 'plan-review' | 'implement' | 'review' | 'publish' | 'ci';

const STEP_ORDER: readonly Exclude<TicketPhaseStepId, 'ci'>[] = [
  'refine',
  'plan-review',
  'implement',
  'review',
  'publish',
] as const;

const STEP_LABELS: Record<TicketPhaseStepId, string> = {
  refine: 'Refine',
  'plan-review': 'Plan review',
  implement: 'Implement',
  review: 'Review',
  publish: 'Publish',
  ci: 'CI',
};

export interface TicketPhaseHint {
  text: string;
  quiet?: boolean;
}

export interface TicketPhaseStepperView {
  steps: StepSpec[];
  hint?: TicketPhaseHint;
}

function has(ticket: PipenzoTicketViewV1, label: PipenzoLabelV1): boolean {
  return ticket.labels.includes(label);
}

/**
 * "Parked, needs a human" in the plain sense README's `pipenzo:needs-human` row means -- three
 * consecutive failures, or a denied approval -- as opposed to the five more specific Needs-human
 * variants that each carry their own condition label (or, for a pending plan review, local marker)
 * and their own visual treatment below.
 */
function isGenericNeedsHuman(ticket: PipenzoTicketViewV1): boolean {
  return (
    ticket.lane === 'needs-human' &&
    !has(ticket, 'pipenzo:needs-pre-scoping') &&
    !has(ticket, 'pipenzo:awaiting-stack-approval') &&
    !has(ticket, 'pipenzo:interrupted') &&
    !has(ticket, 'pipenzo:merge-conflict') &&
    !has(ticket, 'pipenzo:ci-failed') &&
    // Issue #15: a pending plan review also parks under the bare `pipenzo:needs-human` label (see
    // `planReviewStatus`'s own doc comment) -- `ticket.planReview`'s presence is its real signal.
    !ticket.planReview
  );
}

function refineStatus(ticket: PipenzoTicketViewV1): StepStatus {
  if (ticket.lane === 'queued') return 'upcoming';
  if (ticket.phase !== 'refine') return 'done';
  if (ticket.lane === 'working') return 'active';
  if (isGenericNeedsHuman(ticket)) return 'fail';
  // Refine finished; the ticket is either at the plan-review gate or genuinely stuck there
  // (needs-pre-scoping/awaiting-stack-approval), both of which the plan-review step reports.
  return 'done';
}

function planReviewStatus(ticket: PipenzoTicketViewV1): StepStatus {
  if (ticket.phase !== 'refine') return 'done';
  if (ticket.lane !== 'needs-human') return 'upcoming';
  // Issue #15: a clean Refine verdict, no dedicated label -- see this module's own doc comment.
  if (ticket.planReview) return 'await';
  if (has(ticket, 'pipenzo:awaiting-stack-approval')) return 'await';
  // A refusal is a finished outcome, not something still being waited on -- see `refine-gate.ts`'s
  // `refuse` verdict and README's "refusal is a real ticket state, not an error".
  if (has(ticket, 'pipenzo:needs-pre-scoping')) return 'fail';
  return 'upcoming';
}

function implementStatus(ticket: PipenzoTicketViewV1): StepStatus {
  if (ticket.phase === 'refine') return 'upcoming';
  if (ticket.phase !== 'implement') return 'done';
  if (ticket.lane === 'working') return 'active';
  if (isGenericNeedsHuman(ticket) || has(ticket, 'pipenzo:interrupted')) return 'fail';
  return 'done';
}

function reviewStatus(ticket: PipenzoTicketViewV1): StepStatus {
  if (ticket.phase === 'refine' || ticket.phase === 'implement') return 'upcoming';
  if (ticket.phase !== 'review') return 'done';
  if (ticket.lane === 'working') return 'active';
  if (isGenericNeedsHuman(ticket) || has(ticket, 'pipenzo:interrupted')) return 'fail';
  return 'done'; // 'ready-for-review', or a condition label riding along with it
}

function publishStatus(ticket: PipenzoTicketViewV1): StepStatus {
  // README: "Needs human | The approved branch no longer merges cleanly" -- discovered only after
  // a human already said yes to publishing, so it fails the publish step, not review.
  if (has(ticket, 'pipenzo:merge-conflict')) return 'fail';
  // README's own words for this lane: "Gates passed, awaiting the human push gate" -- true whether
  // this is the first push or, carrying `pipenzo:ci-failed` forward, a fix re-entering the same gate.
  if (ticket.lane === 'ready-for-review') return 'await';
  return 'upcoming';
}

function hintFor(ticket: PipenzoTicketViewV1): TicketPhaseHint | undefined {
  // Issue #15: checked before `isGenericNeedsHuman`'s own fallback below, the same way the other
  // specific-signal hints in this function are -- `TicketDetail.dc.html`'s own plan-review mockup
  // text, read exactly, minus the mockup's invented timestamp.
  if (ticket.planReview) {
    return { text: 'Plan review — waiting on you' };
  }
  if (has(ticket, 'pipenzo:awaiting-stack-approval')) {
    return { text: 'Stack awaiting sign-off' };
  }
  if (has(ticket, 'pipenzo:needs-pre-scoping')) {
    return { text: 'Declined at Refine — finished outcome', quiet: true };
  }
  if (has(ticket, 'pipenzo:merge-conflict')) {
    return { text: 'Branch no longer merges — needs a human' };
  }
  if (has(ticket, 'pipenzo:interrupted')) {
    return { text: 'The daemon died mid-run — needs a human' };
  }
  if (has(ticket, 'pipenzo:ci-failed')) {
    return ticket.lane === 'ready-for-review'
      ? { text: 'Fix ready — at the push gate' }
      : { text: 'CI failed — needs a human' };
  }
  if (ticket.lane === 'ready-for-review') {
    return { text: 'Waiting on you — ready to publish' };
  }
  if (isGenericNeedsHuman(ticket)) {
    return { text: 'Parked — needs a human' };
  }
  return undefined;
}

const STATUS_OF: Record<Exclude<TicketPhaseStepId, 'ci'>, (ticket: PipenzoTicketViewV1) => StepStatus> = {
  refine: refineStatus,
  'plan-review': planReviewStatus,
  implement: implementStatus,
  review: reviewStatus,
  publish: publishStatus,
};

/** The real phase-machine binding: no mocked phase data, every field read from the wire ticket. */
export function ticketPhaseSteps(ticket: PipenzoTicketViewV1): TicketPhaseStepperView {
  const steps: StepSpec[] = STEP_ORDER.map((id, index) => ({
    id,
    label: STEP_LABELS[id],
    status: STATUS_OF[id](ticket),
    number: index + 1,
  }));

  // The appended CI step (issue #91's "appended CI step" requirement): only when CI results exist
  // for this ticket, i.e. it still carries `pipenzo:ci-failed` -- README states that label rides
  // along through the whole ci-failed lifecycle, so its presence alone is the "CI ran" signal.
  if (has(ticket, 'pipenzo:ci-failed')) {
    steps.push({ id: 'ci', label: STEP_LABELS.ci, status: 'fail', number: steps.length + 1 });
  }

  return { steps, hint: hintFor(ticket) };
}
