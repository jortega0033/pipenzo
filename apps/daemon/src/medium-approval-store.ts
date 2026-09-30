import { randomUUID } from 'node:crypto';
import {
  captureUndoSnapshot,
  isUndoSnapshotExpired,
  restoreUndoSnapshot,
  type UndoSnapshotV1,
  type UndoOutcome,
} from './undo-snapshot.js';
import type { PipenzoGitRunner } from './pipenzo-git.js';

/**
 * The daemon-side half of the MEDIUM inline approval flow (Pipenzo issue #97): a real, in-process
 * blocking gate around one MEDIUM-graded action, from "capture the pre-action state" through
 * "a human decided" to "maybe restore it later".
 *
 * ## What "blocking gate" means here
 *
 * There is no live agent tool call to pause mid-flight for this ticket's real call site
 * (`PublishActions.tsx`'s push / push-and-open-PR buttons) -- see `pipenzo-phase-sessions.ts`'s own
 * module comment on why Pipenzo's phase sessions run on the legacy dispatch with no live per-call
 * permission callback yet, and `review-gates.ts`'s `classifyReviewRisk()` doc comment on why a
 * completed review's own risk grade can never come out MEDIUM in the first place. What genuinely
 * blocks here is call order, enforced by this module rather than by convention at the call site:
 * the gated action cannot be dispatched by a caller that does not already hold a `snapshotId` from
 * `capture()`, and `capture()` itself does the one filesystem read this gate needs *before* that
 * action runs (`captureUndoSnapshot`'s own "pre-action state" contract). A caller that skips
 * straight to `decide()` with a snapshot id this store never issued gets `undefined` back, not a
 * decision it can quietly treat as approved.
 *
 * ## One decision per snapshot (CLAUDE.md hard rule #4)
 *
 * `decide()` deletes a pending entry from `#pending` the moment it resolves it, allow or reject
 * alike, and looks the id up in `#pending` only -- so a caller that calls `decide()` twice for the
 * same id (a double-click, a retried request) gets `undefined` the second time rather than a second
 * "yes" or a corrected "no". This is the same shape `runtime.interactions.claim()` uses in
 * `session-manager.ts` for exactly the reason CLAUDE.md hard rule #4 states: a decision, once made,
 * is not something a caller can re-ask for a different answer to.
 *
 * ## Cross-ticket isolation
 *
 * Every method takes `ticketId` alongside `snapshotId` and refuses (`undefined`) unless the
 * snapshot on file was captured for that exact ticket. A snapshot id is a random UUID, so guessing
 * one is not the realistic attack -- the property this buys is that a route bug that mixes up two
 * tickets' ids on one call cannot cross-wire a decision, an undo, or a status read onto the wrong
 * ticket's snapshot, because the mismatch is checked here, once, rather than trusted at every call
 * site that happens to have both ids in scope.
 */

export interface MediumApprovalEntry {
  readonly ticketId: string;
  readonly snapshot: UndoSnapshotV1;
  readonly decision?: 'allow' | 'reject';
  readonly reason?: string;
  readonly decidedAt?: string;
}

export interface CaptureMediumApprovalInput {
  readonly ticketId: string;
  readonly worktreeRoot: string;
  readonly branch: string;
  readonly touchedPaths: readonly string[];
  readonly gitRunner?: PipenzoGitRunner;
}

export class MediumApprovalStore {
  // Pending (not yet decided) and resolved-but-not-yet-undone entries share one map: a `decide()`
  // that already ran leaves its entry in place (with `decision`/`decidedAt` set) exactly until
  // `undo()` consumes it, since the resolved-line UI (`ResolvedMediumLine`) still needs to poll its
  // status and potentially restore it after `decide()` has already returned. "Pending" below means
  // "no `decision` set yet", not "present in this map".
  //
  // **Known gap, not yet closed by this ticket:** an *allowed* entry nobody ever undoes -- the
  // common case, since most approvals are never undone -- has no other removal path and holds real
  // file content (`UndoSnapshotV1.entries[].content`) for the rest of this daemon process's
  // lifetime. A `reject`ed entry is deleted immediately (`decide()` below), so the unbounded-growth
  // exposure here is specifically "allowed and never undone," not every decided snapshot. This is a
  // real reliability gap on a long-running daemon, not a security one (this store sits behind the
  // same bearer-token-authenticated local surface as the rest of `/v2/pipenzo/*`, so the only party
  // that can grow it is the daemon's own already-trusted caller) -- a size cap or age-based sweep is
  // tracked as a follow-up rather than built speculatively here.
  readonly #entries = new Map<string, MediumApprovalEntry>();

  /**
   * Captures the worktree's pre-action state for exactly `input.touchedPaths`, fixed at
   * `riskGrade: 'medium'` -- this store only ever exists for MEDIUM actions (CLAUDE.md hard rule
   * #3: HIGH never gets an Undo, and `captureUndoSnapshot` itself refuses a HIGH grade outright), so
   * there is no caller-supplied grade to get wrong here. Returns the new entry's id.
   */
  async capture(input: CaptureMediumApprovalInput): Promise<string> {
    const snapshot = await captureUndoSnapshot({
      worktreeRoot: input.worktreeRoot,
      branch: input.branch,
      touchedPaths: input.touchedPaths,
      riskGrade: 'medium',
      gitRunner: input.gitRunner,
    });
    const id = randomUUID();
    this.#entries.set(id, { ticketId: input.ticketId, snapshot });
    return id;
  }

  /** The entry for `snapshotId`, iff it belongs to `ticketId` -- every other method routes through
   * this so the cross-ticket check happens in exactly one place. */
  #owned(ticketId: string, snapshotId: string): MediumApprovalEntry | undefined {
    const entry = this.#entries.get(snapshotId);
    return entry && entry.ticketId === ticketId ? entry : undefined;
  }

  /**
   * Records a human's Allow/Reject for a still-pending snapshot. Returns `undefined` for an unknown
   * id, a wrong ticket, or a snapshot already decided -- never re-answers a decision already made.
   *
   * Deliberately does not itself call `recordRiskApprovalOutcome` or run the gated action -- both
   * are the route's job (`routes/pipenzo-medium-approval.ts`), which has the `PipenzoPhaseMachine`
   * this module has no reason to depend on. What this method owns is purely "was this the first
   * decision for this id, and if so, which one".
   */
  decide(ticketId: string, snapshotId: string, decision: 'allow' | 'reject', reason?: string): MediumApprovalEntry | undefined {
    const entry = this.#owned(ticketId, snapshotId);
    if (!entry || entry.decision) return undefined;
    const decided: MediumApprovalEntry = {
      ...entry,
      decision,
      reason,
      decidedAt: new Date().toISOString(),
    };
    if (decision === 'reject') {
      // A rejected action never ran, so there is nothing to ever undo -- keeping the entry around
      // would only let a caller call `undo()` on an action that was never allowed to touch
      // anything. Discarding here, not in the route, keeps that invariant here too.
      this.#entries.delete(snapshotId);
      return decided;
    }
    this.#entries.set(snapshotId, decided);
    return decided;
  }

  /** A read-only peek at whether `snapshotId`'s undo is still available, without restoring
   * anything -- `isUndoSnapshotExpired()`'s own doc comment explains why this never touches the
   * filesystem. `undefined` for an unknown id, a wrong ticket, or one still pending a decision (an
   * un-decided action never ran, so "undo" does not yet mean anything for it). */
  async status(
    ticketId: string,
    snapshotId: string,
  ): Promise<{ readonly available: boolean; readonly reason?: 'expired' | 'high_risk_blocked' } | undefined> {
    const entry = this.#owned(ticketId, snapshotId);
    if (!entry || entry.decision !== 'allow') return undefined;
    const { expired, reason } = await isUndoSnapshotExpired(entry.snapshot);
    return { available: !expired, reason };
  }

  /** Restores an allowed snapshot's touched paths, then discards the entry regardless of outcome --
   * a spent or expired snapshot is not retried, matching `restoreUndoSnapshot`'s own one-shot
   * contract. `undefined` for an unknown id, a wrong ticket, or one never allowed. */
  async undo(ticketId: string, snapshotId: string): Promise<UndoOutcome | undefined> {
    const entry = this.#owned(ticketId, snapshotId);
    if (!entry || entry.decision !== 'allow') return undefined;
    this.#entries.delete(snapshotId);
    return restoreUndoSnapshot(entry.snapshot);
  }

  /** Test/diagnostic-only: how many entries (pending or resolved-but-not-undone) this store is
   * currently holding, so a test can assert a reject/undo actually freed its entry rather than
   * leaking it. */
  get size(): number {
    return this.#entries.size;
  }
}
