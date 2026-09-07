import {
  PIPENZO_LABEL_LANES,
  PIPENZO_SCHEMA_V1_MARKER_LABEL,
  isPipenzoLabel,
  pipenzoLabelV1Schema,
  type PipenzoLabelV1,
  type PipenzoLaneV1,
  type PipenzoTicketRecordV1,
} from '@agent-dock/shared';
import {
  GitHubClientError,
  parseRepoRef,
  type GitHubClient,
  type RepoRef,
} from './github-client.js';
import type { FileTicketStore } from './pipenzo-ticket-store.js';

/**
 * The phase machine (Pipenzo issue #188): the implementation of README's one precedence rule.
 *
 * > **GitHub labels are authoritative for a ticket's lane.** The JSON ticket store is authoritative
 * > for everything GitHub cannot hold. When the two disagree about a lane, the divergence is
 * > recorded and **the label wins**; the local record is reconciled to it, never the other way
 * > around.
 *
 * `pipenzo-phase-service.ts` is not this, despite the name. It composes the three phase *executors*
 * (`RefineSubagent`, `ImplementOrchestrator`, `ReviewGatesRunner`), holds no state between calls,
 * and never reads or writes a lane. This module is the state machine: what transitions are legal,
 * in what order the two stores are written, and what happens when they disagree.
 *
 * ## Why a transition names a label, not a lane
 *
 * `transition()` takes a `pipenzo:` label and derives the lane from it, rather than taking a lane.
 * That direction is forced by the data: `PIPENZO_LANES` has four entries and `PIPENZO_LABELS` has
 * ten, because five different labels (`needs-human`, `needs-pre-scoping`, `awaiting-stack-approval`,
 * `ci-failed`, `merge-conflict`, `interrupted`) all render in the *same* Needs-human column while
 * meaning six different things. A caller that could only name a lane could not say *why* a ticket
 * needs a human, and the label — the authoritative side — would have to be guessed from the lane.
 * Naming the label and deriving the lane makes the authoritative value the one the caller states.
 *
 * ## Write order: GitHub first, local second
 *
 * Stated by #188 and worth keeping stated, because it looks backwards — the slow, failure-prone,
 * over-the-network write goes first, and the fast local one second. The reason is what each order
 * leaves behind when the process dies between the two writes:
 *
 * - **Label first, record second** (this order): GitHub has the new lane, the local record has the
 *   old one. The authoritative side is correct, and `read()` below reconciles the stale local record
 *   to it on the next read. Self-healing.
 * - **Record first, label second**: the local record claims a lane GitHub never agreed to. The
 *   authoritative side is stale, and label-wins reconciliation would faithfully *undo* the
 *   transition — silently reverting completed work to its previous state.
 *
 * A crash between the two writes is not the unlikely case here. The label write is a network round
 * trip to a rate-limited API, so it is precisely the step most likely to be interrupted.
 *
 * ## The schema marker has to be re-asserted on every write
 *
 * `GitHubClient.setIssueLabels` *replaces* the `pipenzo:` namespace rather than adding to it —
 * deliberately, so a lane transition cannot leave the previous lane's label in place and put one
 * ticket in two lanes at once. The consequence is easy to miss: `pipenzo:schema-v1` is also in that
 * namespace, so a transition that wrote only the new state label would strip the schema marker off
 * the issue as a side effect, and README's *Schema versioning* rule (a newer Pipenzo meeting an
 * older marker goes read-only rather than writing v2 semantics over v1 state) would quietly stop
 * working on every ticket this machine ever touched. Every write here carries the marker.
 *
 * The same applies to `pipenzo:ci-failed`, which README says stays on a ticket *through* its move to
 * Ready-for-review — see `PIPENZO_CONDITION_LABELS` for why that one label is treated as a condition
 * the transition carries forward rather than a state the transition replaces.
 *
 * Foreign labels — a human's `bug`, `good first issue`, a release marker — are preserved by
 * `setIssueLabels` itself rather than by this module, for the reason its own comment gives: a rule
 * enforced at one call site is a rule the second call site forgets.
 *
 * ## Not in scope
 *
 * Polling (build step 4, #161's ETag layer) — this machine transitions on demand and reconciles on
 * read. Writing the detected divergence to the audit store is #149 under build step 6; this module
 * owns *detecting* it and applying label-wins, and surfaces what it found so #149 has something to
 * record.
 */

/* ------------------------------------------------------------------ vocabulary */

/**
 * A label that actually puts a ticket in a lane — the nine of ten that map to a non-null lane.
 * `pipenzo:schema-v1` is excluded by construction: it is a marker that coexists with any real
 * state, so "transition the ticket to schema-v1" is not a sentence that means anything.
 */
export type PipenzoLaneBearingLabelV1 = Exclude<PipenzoLabelV1, typeof PIPENZO_SCHEMA_V1_MARKER_LABEL>;

export function isLaneBearingLabel(label: PipenzoLabelV1): label is PipenzoLaneBearingLabelV1 {
  return PIPENZO_LABEL_LANES[label] !== null;
}

/** The lane a lane-bearing label puts a ticket in. Total over `PipenzoLaneBearingLabelV1`. */
export function laneForLabel(label: PipenzoLaneBearingLabelV1): PipenzoLaneV1 {
  const lane = PIPENZO_LABEL_LANES[label];
  // Unreachable through the exported surface: `PipenzoLaneBearingLabelV1` excludes the one label
  // that maps to null. The throw is here so a future tenth label added to `PIPENZO_LABELS` with a
  // null lane fails loudly at the one place that assumes otherwise, rather than returning undefined.
  if (lane === null) throw new Error(`label carries no lane: ${label}`);
  return lane;
}

/**
 * The legal lane transitions.
 *
 * Every pair is allowed except one: **`queued` → `ready-for-review`**. A ticket cannot present
 * itself for review without ever having been worked — that is the single move that would let a
 * ticket skip the entire loop this product exists to run, and it is the only pair with no
 * legitimate operator story behind it.
 *
 * The permissiveness elsewhere is deliberate rather than lazy, and each one has a real case:
 *
 * - **Self-transitions** (`queued` → `queued`, and so on) are legal because they are how a ticket
 *   moves *between the five Needs-human labels* — `needs-human` → `interrupted` is a real and
 *   necessary transition that never changes the lane. Refusing self-transitions would make the
 *   Needs-human column's own state changes illegal. They are also what makes a retried transition
 *   idempotent after a crash between the two writes described above.
 * - **`needs-human` → `ready-for-review`** is README's own `pipenzo:ci-failed` row, verbatim:
 *   "Needs human → Ready for review once the fix commits".
 * - **`ready-for-review` → `working`** is a review that found something, sending the ticket back.
 * - **`queued` → `needs-human`** is a ticket that needs decomposition before any work starts
 *   (`pipenzo:needs-pre-scoping`), which is a pre-scoping refusal, not a failure after work.
 * - **`working` → `queued`**, and **`ready-for-review` → `queued`**, are an abandoned attempt
 *   returned to the queue: the first when the attempt is given up mid-flight, the second when a
 *   human rejects finished work outright and wants a fresh attempt rather than a fix on top of it.
 */
export const PIPENZO_LEGAL_LANE_TRANSITIONS: Readonly<
  Record<PipenzoLaneV1, readonly PipenzoLaneV1[]>
> = Object.freeze({
  queued: Object.freeze(['queued', 'working', 'needs-human'] as const),
  working: Object.freeze(['working', 'queued', 'ready-for-review', 'needs-human'] as const),
  'ready-for-review': Object.freeze([
    'ready-for-review',
    'working',
    'queued',
    'needs-human',
  ] as const),
  'needs-human': Object.freeze([
    'needs-human',
    'queued',
    'working',
    'ready-for-review',
  ] as const),
});

export function isLegalLaneTransition(from: PipenzoLaneV1, to: PipenzoLaneV1): boolean {
  return PIPENZO_LEGAL_LANE_TRANSITIONS[from].includes(to);
}

/**
 * The labels that describe a *condition* a ticket is under rather than the *state* it is in, and
 * that therefore survive a lane transition instead of being replaced by it.
 *
 * Exactly one label qualifies, and README's label table says so explicitly rather than leaving it
 * to be inferred — `pipenzo:ci-failed` is the only row whose lane is written as a transition rather
 * than a value:
 *
 * > `pipenzo:ci-failed` | Needs human → **Ready for review** once the fix commits | A post-merge-
 * > request check failed. **The label stays on the ticket**, but a ticket carrying it moves to Ready
 * > for review the moment the forked fix attempt commits and is waiting on the push gate — it isn't
 * > stuck in Needs human for the whole CI-failure lifecycle, only for the part where nobody has
 * > looked at it yet.
 *
 * Two consequences, both handled below and neither optional if that row is to be true:
 *
 * 1. `transition()` **retains** a condition label across a write. Without that, moving a CI-failed
 *    ticket to Ready-for-review would strip the very label README says stays on it, and the
 *    CI-failure lifecycle would lose its own marker at the one moment it matters.
 * 2. A **state** label outranks a condition label when deriving the lane. `pipenzo:ci-failed` maps
 *    to `needs-human` in `PIPENZO_LABEL_LANES`, and that map is right about a ticket carrying it
 *    *alone* — "the part where nobody has looked at it yet". But once the fix commits, the issue
 *    carries `ci-failed` **and** `ready-for-review`, and the lane has to be Ready-for-review. A rule
 *    that just took the most-halting lane would answer Needs-human there, which is precisely
 *    backwards from the table.
 *
 * `pipenzo:merge-conflict` is deliberately **not** here. It looks symmetrical — another problem
 * discovered on the PR — but its row reads plainly "Needs human", with no cross-lane lifecycle, and
 * README says Pipenzo does not attempt a rebase itself. Adding it on grounds of symmetry would be
 * inventing a lifecycle the design does not describe.
 */
const PIPENZO_CONDITION_LABELS: ReadonlySet<PipenzoLabelV1> = new Set<PipenzoLabelV1>([
  'pipenzo:ci-failed',
]);

export function isConditionLabel(label: PipenzoLabelV1): boolean {
  return PIPENZO_CONDITION_LABELS.has(label);
}

/**
 * Which lane wins when an issue carries more than one *state* label at once.
 *
 * This is not a tiebreak between equals; it is a safety ordering, and it runs in one direction:
 * **prefer the lane that halts automation.** A ticket labelled both `working` and `needs-human`
 * (a teammate flagged a running ticket on github.com) has to read as Needs-human, because the
 * alternative is Pipenzo continuing to dispatch work on a ticket a human has just stopped. By the
 * same reasoning `ready-for-review` outranks `working`: it waits for a person, `working` dispatches.
 *
 * It applies to state labels only. Condition labels are consulted for a lane just once, as a
 * fallback when no state label is present at all — see `PIPENZO_CONDITION_LABELS`.
 *
 * Ambiguity is reported by `read()` rather than silently resolved — a human put a second state label
 * on that issue and should be told the machine had to pick — but it must still resolve to exactly
 * one lane, because a kanban card cannot be in two columns.
 */
const LANE_PRECEDENCE: readonly PipenzoLaneV1[] = Object.freeze([
  'needs-human',
  'ready-for-review',
  'working',
  'queued',
] as const);

/* ---------------------------------------------------------------------- errors */

export const PIPENZO_PHASE_MACHINE_ERROR_CODES = [
  'invalid_request',
  'ticket_not_found',
  'illegal_transition',
  'token_missing',
  'invalid_repository',
  'issue_not_found',
  'github_unauthorized',
  'github_forbidden',
  'github_rate_limited',
  'github_failed',
] as const;

export type PipenzoPhaseMachineErrorCode = (typeof PIPENZO_PHASE_MACHINE_ERROR_CODES)[number];

/** Same shape as `PipenzoPhaseError`: a closed `code` union routes map onto statuses. */
export class PipenzoPhaseMachineError extends Error {
  readonly code: PipenzoPhaseMachineErrorCode;
  readonly details: readonly string[];

  constructor(
    code: PipenzoPhaseMachineErrorCode,
    message: string,
    details: readonly string[] = [],
  ) {
    super(message);
    this.name = 'PipenzoPhaseMachineError';
    this.code = code;
    this.details = details.slice(0, 20).map((detail) => detail.slice(0, 500));
  }
}

const GITHUB_CODES: Record<GitHubClientError['code'], PipenzoPhaseMachineErrorCode> = {
  token_missing: 'token_missing',
  invalid_repository: 'invalid_repository',
  invalid_request: 'invalid_request',
  unauthorized: 'github_unauthorized',
  forbidden: 'github_forbidden',
  not_found: 'issue_not_found',
  rate_limited: 'github_rate_limited',
  invalid_response: 'github_failed',
  network: 'github_failed',
};

function toMachineError(error: unknown): PipenzoPhaseMachineError {
  if (error instanceof PipenzoPhaseMachineError) return error;
  if (error instanceof GitHubClientError) {
    // `GitHubClientError` redacts its own message at construction, so it is safe to surface.
    return new PipenzoPhaseMachineError(GITHUB_CODES[error.code], error.message);
  }
  return new PipenzoPhaseMachineError('github_failed', 'phase machine operation failed');
}

/* ------------------------------------------------------------- reconciliation */

/**
 * What `read()` found when it compared the local record against the issue's labels.
 *
 * - `none` — the two agree; nothing was rewritten.
 * - `lane_reconciled` — they disagreed, the label won, the local record was rewritten to match.
 * - `ambiguous_labels` — the issue carried more than one lane-bearing label; `LANE_PRECEDENCE`
 *   picked one. May or may not also have changed the local lane, so `changed` says which.
 * - `unlabelled` — the issue carries no lane-bearing `pipenzo:` label at all.
 */
export type PipenzoTicketDivergenceKind =
  | 'none'
  | 'lane_reconciled'
  | 'ambiguous_labels'
  | 'unlabelled';

export interface PipenzoTicketReconciliation {
  readonly ticket: PipenzoTicketRecordV1;
  readonly divergence: PipenzoTicketDivergenceKind;
  /** The lane the local record held before this read. */
  readonly previousLane: PipenzoLaneV1;
  /** Every lane-bearing `pipenzo:` label seen on the issue, in `PIPENZO_LABELS` order. */
  readonly observedLabels: readonly PipenzoLaneBearingLabelV1[];
  /** True when the local record was rewritten as a result of this read. */
  readonly changed: boolean;
}

export interface PipenzoPhaseMachineOptions {
  tickets: FileTicketStore;
  /** Built lazily from a token read at call time, so no authenticated client is retained. */
  github?: () => GitHubClient;
}

/* --------------------------------------------------------------- the machine */

export class PipenzoPhaseMachine {
  readonly #tickets: FileTicketStore;
  readonly #github: (() => GitHubClient) | undefined;

  constructor(options: PipenzoPhaseMachineOptions) {
    this.#tickets = options.tickets;
    this.#github = options.github;
  }

  /**
   * Moves a ticket to `toLabel`: GitHub first, the local record second.
   *
   * The lane the transition is judged *from* is the reconciled one, not the local record's — this
   * calls `read()` first on purpose. Validating against a stale local lane would let a transition
   * that is illegal from the ticket's real state pass because the local copy had not caught up yet,
   * which is the precedence rule holding in the easy case and quietly failing in the one it exists
   * for.
   */
  async transition(
    ticketId: string,
    toLabel: PipenzoLaneBearingLabelV1,
  ): Promise<PipenzoTicketReconciliation> {
    const parsedLabel = pipenzoLabelV1Schema.safeParse(toLabel);
    if (!parsedLabel.success || !isLaneBearingLabel(parsedLabel.data)) {
      throw new PipenzoPhaseMachineError('invalid_request', 'not a lane-bearing pipenzo label');
    }
    const label = parsedLabel.data;
    const target = laneForLabel(label);

    // Reconcile before deciding, so the transition is judged against the authoritative lane.
    const current = await this.read(ticketId);
    if (!isLegalLaneTransition(current.ticket.lane, target)) {
      throw new PipenzoPhaseMachineError(
        'illegal_transition',
        `cannot move a ticket from ${current.ticket.lane} to ${target}`,
      );
    }

    const ref = this.#repoRef(current.ticket);
    const client = this.#requireGitHub();

    // Everything that has to survive this write, because `setIssueLabels` replaces the whole
    // `pipenzo:` namespace: the new state label, the schema marker (see the module comment), and any
    // condition label already on the ticket (see `PIPENZO_CONDITION_LABELS` -- README's ci-failed row
    // says that label stays on the ticket *through* the move to Ready-for-review).
    //
    // A transition whose own target is a condition label does not duplicate it, and does not drag
    // the previous state label along: entering the CI-failure lifecycle is itself a state change.
    // Read from what was just *observed on the issue*, never from the local record's `labels`. The
    // two differ in exactly the case that matters: when a human strips every `pipenzo:` label off an
    // issue, `read()` reports `unlabelled` and deliberately leaves the local record alone (it has
    // nothing authoritative to reconcile to), so the record still lists a condition label GitHub no
    // longer has. Retaining from the record there would re-add a label a person had just deleted --
    // the local side overwriting the authoritative one, which is the one thing this machine exists
    // to prevent.
    const retainedConditions = isConditionLabel(label)
      ? []
      : current.observedLabels.filter(
          (existing) => isConditionLabel(existing) && existing !== label,
        );

    // The authoritative write.
    let resulting: readonly string[];
    try {
      resulting = await client.setIssueLabels(ref, current.ticket.issueNumber, [
        label,
        ...retainedConditions,
        PIPENZO_SCHEMA_V1_MARKER_LABEL,
      ]);
    } catch (error) {
      throw toMachineError(error);
    }

    // Persist what GitHub *reports*, not what we asked for. The two can differ -- a concurrent write
    // from another Pipenzo instance or a person, between our write and its response -- and the
    // whole point of the precedence rule is that the local record follows GitHub rather than our
    // intent.
    const observedLabels = laneBearingLabelsOf(resulting);
    const reconciledLane = laneFromObserved(observedLabels) ?? target;
    const next: PipenzoTicketRecordV1 = {
      ...current.ticket,
      lane: reconciledLane,
      labels: pipenzoLabelsOf(resulting),
    };
    this.#tickets.update(ticketId, next);

    return {
      ticket: next,
      divergence: divergenceFor(observedLabels, current.ticket.lane, reconciledLane),
      previousLane: current.ticket.lane,
      observedLabels,
      changed: true,
    };
  }

  /**
   * Reads a ticket, reconciling it against the issue's labels first. This is the read path every
   * caller should use: it is where "the label wins" actually happens.
   */
  async read(ticketId: string): Promise<PipenzoTicketReconciliation> {
    const ticket = this.#tickets.get(ticketId);
    if (!ticket) {
      throw new PipenzoPhaseMachineError('ticket_not_found', `no such ticket: ${ticketId}`);
    }

    const ref = this.#repoRef(ticket);
    const client = this.#requireGitHub();
    let issueLabels: readonly string[];
    try {
      issueLabels = (await client.getIssue(ref, ticket.issueNumber)).labels;
    } catch (error) {
      throw toMachineError(error);
    }

    const observedLabels = laneBearingLabelsOf(issueLabels);
    const authoritativeLane = laneFromObserved(observedLabels);

    // No lane-bearing label at all: GitHub asserts no lane, so there is nothing to reconcile *to*.
    // The local lane is kept rather than cleared -- "the label wins" settles a disagreement between
    // two stated lanes, and an absent label states nothing. Clearing the local record here would
    // turn a human deleting a label (or a partially-applied write) into silent data loss on the one
    // side that holds the worktree, attempt lineage and budget.
    if (authoritativeLane === undefined) {
      return {
        ticket,
        divergence: 'unlabelled',
        previousLane: ticket.lane,
        observedLabels,
        changed: false,
      };
    }

    const storedLabels = pipenzoLabelsOf(issueLabels);
    const laneAgrees = ticket.lane === authoritativeLane;
    const labelsAgree =
      storedLabels.length === ticket.labels.length &&
      storedLabels.every((label) => ticket.labels.includes(label));
    if (laneAgrees && labelsAgree) {
      return {
        ticket,
        divergence: observedLabels.length > 1 ? 'ambiguous_labels' : 'none',
        previousLane: ticket.lane,
        observedLabels,
        changed: false,
      };
    }

    const reconciled: PipenzoTicketRecordV1 = {
      ...ticket,
      lane: authoritativeLane,
      labels: storedLabels,
    };
    this.#tickets.update(ticketId, reconciled);

    return {
      ticket: reconciled,
      divergence: divergenceFor(observedLabels, ticket.lane, authoritativeLane),
      previousLane: ticket.lane,
      observedLabels,
      changed: true,
    };
  }

  #repoRef(ticket: PipenzoTicketRecordV1): RepoRef {
    try {
      return parseRepoRef(ticket.repo);
    } catch (error) {
      throw toMachineError(error);
    }
  }

  #requireGitHub(): GitHubClient {
    if (!this.#github) {
      throw new PipenzoPhaseMachineError(
        'token_missing',
        'no GitHub credential is configured for this daemon',
      );
    }
    try {
      return this.#github();
    } catch (error) {
      throw toMachineError(error);
    }
  }
}

/* -------------------------------------------------------------------- helpers */

/** The `pipenzo:` labels in a raw issue label set, deduplicated, in `PIPENZO_LABELS` order. */
function pipenzoLabelsOf(labels: readonly string[]): PipenzoLabelV1[] {
  const seen = new Set<PipenzoLabelV1>();
  for (const name of labels) {
    if (!isPipenzoLabel(name)) continue;
    // An unknown `pipenzo:`-prefixed label is skipped rather than kept: the ticket record's
    // `labels` is closed to `PIPENZO_LABELS`, and a newer Pipenzo's label arriving on a shared repo
    // is exactly the case README's schema marker exists to handle, not something to persist blind.
    const parsed = pipenzoLabelV1Schema.safeParse(name);
    if (parsed.success) seen.add(parsed.data);
  }
  return [...seen];
}

function laneBearingLabelsOf(labels: readonly string[]): PipenzoLaneBearingLabelV1[] {
  return pipenzoLabelsOf(labels).filter(isLaneBearingLabel);
}

/**
 * Applies `LANE_PRECEDENCE` to the observed labels. `undefined` means the issue named no lane at all.
 *
 * State labels are consulted first and condition labels only as a fallback, so a ticket carrying
 * both `pipenzo:ci-failed` and `pipenzo:ready-for-review` lands in Ready-for-review (README's
 * ci-failed row) while a ticket carrying `pipenzo:ci-failed` alone still lands in Needs-human.
 */
function laneFromObserved(
  observed: readonly PipenzoLaneBearingLabelV1[],
): PipenzoLaneV1 | undefined {
  const stateLanes = new Set(observed.filter((label) => !isConditionLabel(label)).map(laneForLabel));
  const fromState = LANE_PRECEDENCE.find((lane) => stateLanes.has(lane));
  if (fromState !== undefined) return fromState;
  const conditionLanes = new Set(
    observed.filter((label) => isConditionLabel(label)).map(laneForLabel),
  );
  return LANE_PRECEDENCE.find((lane) => conditionLanes.has(lane));
}

function divergenceFor(
  observed: readonly PipenzoLaneBearingLabelV1[],
  previousLane: PipenzoLaneV1,
  nextLane: PipenzoLaneV1,
): PipenzoTicketDivergenceKind {
  if (observed.length > 1) return 'ambiguous_labels';
  return previousLane === nextLane ? 'none' : 'lane_reconciled';
}
