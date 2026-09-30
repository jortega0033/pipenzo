import { z } from 'zod';

/**
 * The Models & gates screen's agent-captured panel (Pipenzo issue #470, wiring #123/#124's real
 * panels into a real screen): the operator-facing on/off state behind `AgentCapturedPanel`'s two
 * real toggles, `screenshotEnabled` and `escapeHatchEnabled`.
 *
 * ## Why this is a separate file from `pipenzo-capture-v1.ts`
 *
 * That file is the *capability probe* — what screenshot verification would do for a given
 * repository right now, a real read with nothing persisted. This file is the opposite half: a
 * small piece of durable, human-set configuration, matching the split `pipenzo-concurrency-v1.ts`
 * already draws against `working-lane-concurrency.ts` for the same reason (see that file's own
 * comment). The two meet only at `AgentCapturedPanel`'s own props: `capabilities` comes from the
 * probe, `screenshotEnabled`/`escapeHatchEnabled` come from this schema.
 *
 * ## Why this is a single workspace-level record, not per-repository
 *
 * `PipenzoConcurrencyStore`'s own comment states the same shape for the same reason: there is
 * exactly one of these per daemon state directory. The capability *probe* is real per-repository
 * data (a given checkout either has Playwright or does not), but the operator's stated preference
 * — "verify with screenshots when it's available" — is a workspace-level setting a person sets
 * once in Settings-adjacent UI, not a per-repository toggle nobody asked for.
 *
 * ## What this schema does not yet do
 *
 * Persisting and round-tripping this setting is this ticket's whole scope — see
 * `PipenzoCaptureSettingsStore`'s own module comment for why wiring it into
 * `ScreenshotVerificationRunner`'s actual dispatch (so a screenshot capture is skipped when an
 * operator has switched verification off, even though the repository has Playwright) is real,
 * separate scope this ticket does not take on, matching the honest "not yet enforced" note
 * `pipenzo-concurrency-v1.ts` already carries for its own run-budget field — see this repo's
 * "no fabricated data" discipline (CLAUDE.md) for why that distinction is stated here rather than
 * implied away.
 */

export const PIPENZO_SCREENSHOT_ENABLED_DEFAULT = true;
export const PIPENZO_ESCAPE_HATCH_ENABLED_DEFAULT = false;

/** The full settings record, as `GET /v2/pipenzo/capture-settings` answers with. `.strict()` like
 *  every other Pipenzo wire shape. */
export const pipenzoCaptureSettingsV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    screenshotEnabled: z.boolean(),
    escapeHatchEnabled: z.boolean(),
  })
  .strict();
export type PipenzoCaptureSettingsV1 = z.infer<typeof pipenzoCaptureSettingsV1Schema>;

/**
 * What `PUT /v2/pipenzo/capture-settings` accepts: a partial update, merged onto the stored
 * record — same reasoning `pipenzoConcurrencySettingsUpdateV1Schema` already documents: each
 * toggle is switched independently, so flipping one must not require resending the other, and an
 * empty `{}` is refused rather than silently succeeding as a no-op.
 */
export const pipenzoCaptureSettingsUpdateV1Schema = z
  .object({
    screenshotEnabled: z.boolean().optional(),
    escapeHatchEnabled: z.boolean().optional(),
  })
  .strict()
  .refine(
    (value) => value.screenshotEnabled !== undefined || value.escapeHatchEnabled !== undefined,
    { message: 'at least one of screenshotEnabled or escapeHatchEnabled must be given' },
  );
export type PipenzoCaptureSettingsUpdateV1 = z.infer<typeof pipenzoCaptureSettingsUpdateV1Schema>;
