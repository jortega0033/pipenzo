import { z } from 'zod';

/**
 * Bounded local concurrency (Pipenzo issue #126, split of epic #5's "Queue + dual-audience mode,
 * bounded concurrency"): the workspace-level execution limit a person configures in Settings, and
 * the workspace default run budget beside it.
 *
 * ## Why this is a separate file from `working-lane-concurrency.ts`
 *
 * That file (issue #85) computes a *read-only report* of which Working-lane tickets are held on a
 * file-overlap gate — it takes no configuration and persists nothing. This file is the opposite
 * half: a small piece of durable, human-set configuration that a real enforcement layer reads. The
 * two meet only at one number — `executionLimit` here is what `PIPENZO_DEFAULT_WORKING_CAPACITY`
 * used to be a hardcoded stand-in for (see that file's own comment, and `pipenzo-execution-limiter.ts`
 * for where this number is actually enforced against a live dispatch, not just displayed).
 *
 * ## Why the bounds are baked into the schema, not just documented
 *
 * README and the design canvas (`Settings.dc.html`) both state "default 2, hard cap 4" as a product
 * decision, not a UI convenience — "Bounded local concurrency is the honest ceiling for one machine
 * sharing one subscription's rate limit." Encoding `.min(1).max(4)` here means a daemon that somehow
 * received a value outside that range (a hand-edited state file, a future caller that forgot the
 * bound) fails to parse rather than silently running five sessions at once.
 */

export const PIPENZO_EXECUTION_LIMIT_MIN = 1;
export const PIPENZO_EXECUTION_LIMIT_MAX = 4;
export const PIPENZO_EXECUTION_LIMIT_DEFAULT = 2;

/**
 * The workspace default run budget (`Settings.dc.html`'s "Workspace default run budget" select).
 *
 * This is *not yet enforced* — see `pipenzo-concurrency-store.ts`'s module comment for why wiring
 * it into a ticket's actual `budget.limit` is issue #143's own remaining scope (that ticket's
 * accounting and refusal halves already exist; nothing yet produces a nonzero limit for either
 * half to act on). This schema only makes the choice a real, persisted, round-tripped setting
 * rather than a stepper that changes a number nothing reads — see this repo's "no fabricated data"
 * discipline (CLAUDE.md). `cap_200k_tokens` is the one option name in the canvas that encodes a
 * number; it is kept as a fixed enum member rather than a free-form integer field precisely because
 * nothing downstream currently interprets it — an enum of named choices cannot drift out of sync
 * with an enforcement layer that does not exist yet the way an arbitrary integer could.
 */
export const pipenzoRunBudgetV1Schema = z.enum([
  'unlimited',
  'one_run',
  'three_runs',
  'cap_200k_tokens',
]);
export type PipenzoRunBudgetV1 = z.infer<typeof pipenzoRunBudgetV1Schema>;
export const PIPENZO_RUN_BUDGET_DEFAULT: PipenzoRunBudgetV1 = 'unlimited';

/** The full settings record, as `GET /v2/pipenzo/concurrency` answers with. `.strict()` like every
 *  other Pipenzo wire shape. */
export const pipenzoConcurrencySettingsV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    executionLimit: z
      .number()
      .int()
      .min(PIPENZO_EXECUTION_LIMIT_MIN)
      .max(PIPENZO_EXECUTION_LIMIT_MAX),
    runBudget: pipenzoRunBudgetV1Schema,
  })
  .strict();
export type PipenzoConcurrencySettingsV1 = z.infer<typeof pipenzoConcurrencySettingsV1Schema>;

/**
 * What `PUT /v2/pipenzo/concurrency` accepts: a partial update, merged onto the stored record.
 *
 * Partial rather than `ConnectedReposStore.replace()`'s whole-list-on-every-write shape, because
 * these are two independent settings a person changes one at a time — the stepper's `+`/`-` click
 * must not have to resend whatever the run-budget `<select>` currently holds, and vice versa. At
 * least one field is required (`.refine` below) so an empty `{}` — which would change nothing and
 * would silently succeed by echoing the unchanged record back — is rejected instead, the same
 * "an empty write is a caller bug, not a no-op" reasoning `pipenzoConnectReposRequestV1Schema`'s
 * sibling routes apply elsewhere in this codebase.
 */
export const pipenzoConcurrencySettingsUpdateV1Schema = z
  .object({
    executionLimit: z
      .number()
      .int()
      .min(PIPENZO_EXECUTION_LIMIT_MIN)
      .max(PIPENZO_EXECUTION_LIMIT_MAX)
      .optional(),
    runBudget: pipenzoRunBudgetV1Schema.optional(),
  })
  .strict()
  .refine((value) => value.executionLimit !== undefined || value.runBudget !== undefined, {
    message: 'at least one of executionLimit or runBudget must be given',
  });
export type PipenzoConcurrencySettingsUpdateV1 = z.infer<
  typeof pipenzoConcurrencySettingsUpdateV1Schema
>;
