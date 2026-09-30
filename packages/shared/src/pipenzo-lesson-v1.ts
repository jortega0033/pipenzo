import { z } from 'zod';
import { pipenzoIssueNumberV1Schema, pipenzoRepoRefV1Schema } from './pipenzo-phase-v1.js';

/**
 * Local, human-gated lesson memory (Pipenzo issue #18): the deliberate small substitute for the
 * persistent-knowledge-base idea README explicitly declined to build. A lesson is a one-line note a
 * *person* chose to keep when a ticket resolved — never generated on its own, never sent to a
 * provider, and reviewable and deletable in Settings (issue #128) at any time.
 *
 * ## What "human-gated" means for this schema
 *
 * There is no field here for "confidence", "source session", or anything else that would let a
 * lesson be produced or scored automatically. `text` is prose a human wrote or edited in
 * `LessonPrompt` (`design/artboards/TicketDetail.dc.html`'s `.lesson` prompt, issue #104); the
 * schema only ever receives it after that prompt's "Save lesson" button was clicked. Nothing in
 * this file, or in anything that reads it, is a step toward auto-injecting saved lessons into a
 * future Refine/Implement session — README is explicit that would be "a scope change worth its own
 * decision", not an assumption to bake into the shape of the record.
 *
 * ## Why a lesson is not part of `PipenzoTicketRecordV1`
 *
 * `pipenzo-ticket-v1.ts`'s record is keyed by `ticketId` and is deleted along with the ticket it
 * describes (a ticket's local record has no reason to outlive the ticket). A lesson is the opposite:
 * the design canvas's own copy is "1 lesson across 3 connected repos" and "Handed to the next Refine
 * on this repo" — a lesson is scoped to a *repository*, deliberately outlives the ticket it was
 * saved from, and is listed in Settings across every connected repo at once, the same workspace-wide
 * shape `pipenzoConnectedReposV1Schema` already uses. `issueNumber` below is kept only as the
 * "saved from #94" provenance a person reads, never as a foreign key something joins against.
 */

/** The cap on stored lessons, matching `PIPENZO_MAX_CONNECTED_REPOS`'s reasoning: a real ceiling
 *  far above any plausible real use, so an unbounded list is never a way to grow a local JSON file
 *  without limit by accident. */
export const PIPENZO_MAX_LESSONS = 500;

/** One saved lesson. `.strict()` like every other Pipenzo wire shape, so an extra field is a
 *  validation error here rather than silent cargo the next reader has to explain. */
export const pipenzoLessonV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().uuid(),
    repo: pipenzoRepoRefV1Schema,
    /** The ticket this lesson was saved from, for the "saved from #94" provenance line. Always
     *  present: `LessonPrompt` is only ever offered at a ticket's resolution (README, issue #104),
     *  so there is no path that produces a lesson without one. */
    issueNumber: pipenzoIssueNumberV1Schema,
    /** The one-line note itself, in the person's own words. `LessonPrompt`'s placeholder calls this
     *  "one line", but the bound below is generous rather than a hard single-line enforcement — a
     *  person who pastes two sentences should get a saved lesson, not a rejected save. */
    text: z.string().min(1).max(500),
    /** ISO-8601, set by the store when the lesson is saved. */
    savedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type PipenzoLessonV1 = z.infer<typeof pipenzoLessonV1Schema>;

/** Every saved lesson, across every connected repo — what Settings' lesson-memory panel lists. */
export const pipenzoLessonListV1Schema = z
  .object({
    lessons: z.array(pipenzoLessonV1Schema).max(PIPENZO_MAX_LESSONS),
  })
  .strict();

export type PipenzoLessonListV1 = z.infer<typeof pipenzoLessonListV1Schema>;

/**
 * What `LessonPrompt`'s "Save lesson" hands `POST /v2/pipenzo/lessons` (issue #104).
 * `id`/`savedAt`/`schemaVersion` are the store's to generate, not the caller's: a client-supplied id
 * would let two saves collide, and a client-supplied timestamp would let the "saved … ago" reading
 * drift from when the write actually happened.
 */
export const pipenzoLessonCreateV1Schema = z
  .object({
    repo: pipenzoRepoRefV1Schema,
    issueNumber: pipenzoIssueNumberV1Schema,
    text: z.string().min(1).max(500),
  })
  .strict();

export type PipenzoLessonCreateV1 = z.infer<typeof pipenzoLessonCreateV1Schema>;

/** What Settings' per-item delete sends: the one lesson to remove, and nothing else — a lesson "is
 *  not an index" (the canvas's own words), so deleting one never touches, reorders, or reinterprets
 *  any other saved lesson. */
export const pipenzoLessonDeleteRequestV1Schema = z
  .object({
    id: z.string().uuid(),
  })
  .strict();

export type PipenzoLessonDeleteRequestV1 = z.infer<typeof pipenzoLessonDeleteRequestV1Schema>;
