import { z } from 'zod';
import {
  PIPENZO_LABELS,
  pipenzoLabelV1Schema,
  pipenzoLaneV1Schema,
  pipenzoPhaseV1Schema,
  pipenzoTicketIdV1Schema,
} from './pipenzo-ticket-v1.js';

/**
 * The phase-change stream envelope (build step 3, Pipenzo issue #189).
 *
 * ## Why this is not the session stream
 *
 * Every other SSE surface the daemon serves is *per-session*: `GET /sessions/:id/events` and
 * `GET /v2/sessions/:id/events`, both fanned out from one `SessionManager` subscription. A phase
 * change does not belong to a session. It belongs to a ticket, and a ticket spends most of its life
 * without a session at all -- Refine finishes read-only, with no worktree and no process left to
 * stream from, and the ticket then sits in Ready-for-review until a human moves it. Riding the
 * session stream would mean the board goes blind in exactly the states a human is looking at it.
 *
 * ## Why one stream for every ticket, not one per ticket
 *
 * The envelope carries `ticketId` so a single connection can serve the whole board. The alternative
 * -- a stream per ticket -- would have the board open one SSE connection per card, which is a
 * connection count that grows with the backlog for no gain: a subscriber that wants one ticket
 * filters on `ticketId`, and a subscriber that wants the board (#92's "Needs you" nav, #93's
 * activity stream) would otherwise have to fan in by hand.
 *
 * ## Sequencing
 *
 * `sequence` is daemon-wide and monotonic, and is what a reconnect passes back as `Last-Event-ID`
 * to resume from a cursor rather than from zero. It is deliberately not per-ticket: a per-ticket
 * counter cannot order two tickets' events against each other, which is precisely what a board
 * replaying after a dropped connection needs.
 */
export const PIPENZO_PHASE_EVENT_TYPES = ['ticket.phase_changed'] as const;

export type PipenzoPhaseEventTypeV1 = (typeof PIPENZO_PHASE_EVENT_TYPES)[number];

export const pipenzoPhaseEventTypeV1Schema = z.enum(PIPENZO_PHASE_EVENT_TYPES);

export const pipenzoPhaseEventV1Schema = z
  .object({
    type: pipenzoPhaseEventTypeV1Schema,
    /** Daemon-wide, monotonic, and the value a reconnect sends as `Last-Event-ID`. */
    sequence: z.number().int().min(0),
    ticketId: pipenzoTicketIdV1Schema,
    /** The lane the ticket held before this change. Equal to `toLane` on a label-only move. */
    fromLane: pipenzoLaneV1Schema,
    toLane: pipenzoLaneV1Schema,
    phase: pipenzoPhaseV1Schema,
    /**
     * Every `pipenzo:` label the ticket carries after the change.
     *
     * The lane alone cannot tell a renderer which card to draw: README's label table puts four
     * different Needs-human variants in one lane, and the design canvas draws `pipenzo:interrupted`
     * (#80) differently from a plain `pipenzo:needs-human`. Without the labels every one of those
     * would arrive as an indistinguishable "moved to needs-human".
     */
    labels: z.array(pipenzoLabelV1Schema).max(PIPENZO_LABELS.length),
    /** ISO-8601, daemon clock. */
    at: z.string().datetime(),
  })
  .strict();

export type PipenzoPhaseEventV1 = z.infer<typeof pipenzoPhaseEventV1Schema>;

/**
 * The one non-event frame the phase stream can emit, mirroring protocol v2's `stream.error`: a
 * subscriber too slow to drain its socket is cut loose rather than allowed to grow the daemon's
 * memory without bound. `lastSequence` is where it got to, so a reconnect resumes from there
 * instead of replaying the window from zero.
 */
export const pipenzoPhaseStreamErrorV1Schema = z
  .object({
    type: z.literal('stream.error'),
    code: z.literal('stream_overflow'),
    lastSequence: z.number().int().min(0).optional(),
  })
  .strict();

export type PipenzoPhaseStreamErrorV1 = z.infer<typeof pipenzoPhaseStreamErrorV1Schema>;

export const pipenzoPhaseEventOrStreamErrorV1Schema = z.union([
  pipenzoPhaseEventV1Schema,
  pipenzoPhaseStreamErrorV1Schema,
]);

export type PipenzoPhaseEventOrStreamErrorV1 = z.infer<
  typeof pipenzoPhaseEventOrStreamErrorV1Schema
>;

/**
 * The replay window a subscriber is allowed to resume from, reported with the `replay_gap` refusal
 * when it asks for a cursor the daemon no longer holds. Same shape and same reasoning as the v2
 * session window: the buffer is bounded, so "resume from 0" is a request the daemon must be able to
 * decline honestly rather than answer with a silently truncated history.
 */
export const pipenzoPhaseReplayWindowV1Schema = z
  .object({
    earliestSequence: z.number().int().min(0),
    nextSequence: z.number().int().min(0),
  })
  .strict();

export type PipenzoPhaseReplayWindowV1 = z.infer<typeof pipenzoPhaseReplayWindowV1Schema>;
