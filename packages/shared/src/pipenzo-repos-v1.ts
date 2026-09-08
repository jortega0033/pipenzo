import { z } from 'zod';
import { pipenzoRepoRefV1Schema } from './pipenzo-phase-v1.js';

/**
 * The repositories Pipenzo can see, and the ones it has been told to manage (issue #115).
 *
 * ## Two different lists, deliberately not one
 *
 * `pipenzoRepoListV1` is what GitHub says this credential can reach — a read, recomputed every
 * time it is asked for, never stored. `pipenzoConnectedReposV1` is the workspace's own answer to
 * "which of those should Pipenzo actually work on", which is a decision a human made and which
 * therefore has to survive a restart, a token change, and a repository temporarily disappearing
 * from the listing because a permission changed.
 *
 * Keeping them separate is what makes the second one honest. If the connected list were stored as
 * a filtered copy of the first, a repository the user can no longer see would silently vanish from
 * their configuration — and they would find out by noticing that Pipenzo had stopped watching
 * something, rather than by being told.
 *
 * ## Why a connected entry is just `owner/name`
 *
 * Everything a picker displays — the default branch, the language, the open-issue count, when it
 * was last pushed, whether it is archived — is a property of the repository *now*, not of the
 * decision to connect it. Storing a copy would mean serving stale facts about a repository out of
 * a file, which is the class of bug that makes a UI report a branch that was renamed last week.
 *
 * The identity is `pipenzoRepoRefV1Schema`, the same `owner/name` string every other Pipenzo
 * surface already speaks (a ticket's `repo`, publish, refine, the phase machine). A second,
 * object-shaped repository identity would be a second thing to keep in agreement with
 * `parseRepoRef()`.
 */

/**
 * One row of the picker.
 *
 * `archived` is carried rather than filtered out on the daemon side, because "this repository
 * exists and cannot be worked on" is information the user needs — a picker that silently omitted
 * their archived repositories would read as Pipenzo being unable to see them at all. The picker
 * lists them and refuses to select them, for the reason the design canvas gives: no pull request
 * can be opened against an archived repository, and Pipenzo needs write access to manage one at
 * all.
 *
 * The field list is exactly what the picker renders, and nothing more. GitHub's repository payload
 * is enormous, and every field carried here is one a renderer can come to depend on — so
 * visibility, description, fork status, topics and the rest are deliberately absent until a screen
 * actually shows them. Adding one later is a schema change somebody reviews; carrying one
 * speculatively is a field that quietly becomes load-bearing.
 */
export const pipenzoRepoV1Schema = z
  .object({
    /** `owner/name`. The identity, and what the picker displays and sorts on. */
    fullName: pipenzoRepoRefV1Schema,
    archived: z.boolean(),
    /** The branch a pull request would target. */
    defaultBranch: z.string().min(1).max(255),
    /** GitHub's detected primary language. Absent for an empty repository. */
    language: z.string().max(80).optional(),
    /** Open issues *and* pull requests, which is what GitHub's own field counts. */
    openIssues: z.number().int().min(0),
    /** ISO-8601. Absent for a repository that has never been pushed to. */
    pushedAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict();

export type PipenzoRepoV1 = z.infer<typeof pipenzoRepoV1Schema>;

/**
 * Every repository the credential can reach, in one answer.
 *
 * Deliberately not paginated *to the renderer*, even though it is paginated to GitHub. The picker
 * filters as you type across the whole set, and a filter that only searches the pages it has
 * already fetched is a search box that lies about what it did not find. The daemon walks the pages
 * and answers once.
 *
 * `truncated` is what keeps that honest at the top end. There is a hard page cap, and an account
 * with more repositories than it allows would otherwise get a complete-looking list that is not
 * complete. Saying so is the difference between a missing repository and a mystery.
 */
export const pipenzoRepoListV1Schema = z
  .object({
    repositories: z.array(pipenzoRepoV1Schema).max(3000),
    truncated: z.boolean(),
  })
  .strict();

export type PipenzoRepoListV1 = z.infer<typeof pipenzoRepoListV1Schema>;

/**
 * The cap on connected repositories.
 *
 * A real limit rather than a formality: every connected repository is one the polling reconciler
 * will iterate, and each pass costs GitHub quota. An unbounded list is a way to spend a rate limit
 * by accident, and the ceiling is far above any plausible real selection.
 */
export const PIPENZO_MAX_CONNECTED_REPOS = 50;

/** The workspace's connected-repos list: what a human chose, and when. */
export const pipenzoConnectedReposV1Schema = z
  .object({
    repositories: z.array(pipenzoRepoRefV1Schema).max(PIPENZO_MAX_CONNECTED_REPOS),
    /** ISO-8601, or absent when nothing has ever been connected. */
    updatedAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict();

export type PipenzoConnectedReposV1 = z.infer<typeof pipenzoConnectedReposV1Schema>;

/**
 * Replaces the whole list, rather than adding to it.
 *
 * A picker with checkboxes is a statement about the *complete* selection — unticking a box has to
 * mean something — so an add-only API would make "remove" a second endpoint that the same screen
 * then has to diff against. One writer, one shape, and the request is exactly what the list will be
 * afterwards.
 */
export const pipenzoConnectReposRequestV1Schema = z
  .object({
    repositories: z.array(pipenzoRepoRefV1Schema).max(PIPENZO_MAX_CONNECTED_REPOS),
  })
  .strict();

export type PipenzoConnectReposRequestV1 = z.infer<typeof pipenzoConnectReposRequestV1Schema>;
