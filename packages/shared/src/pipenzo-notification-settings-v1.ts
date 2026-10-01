import { z } from 'zod';

/**
 * Settings' Notifications panel (Pipenzo issue #129, split of epic #6's "Polish -- notifications,
 * the risk classifier, terminal-state worktree cleanup, an audit entry for every publish and gate
 * result"): the four rows `Settings.dc.html`'s own `NOTIFS` seed lets a person actually switch --
 * a refusal or a stack awaiting sign-off, a MEDIUM still blocking after 60 seconds, the tray badge,
 * and sound.
 *
 * ## Why HIGH has no field here
 *
 * The canvas's `NOTIFS` seed never gives "HIGH-risk approvals" an entry in the mutable `notif`
 * state object it reads toggle values from (`{ refusal, medium, badge, sound }` -- no `high` key),
 * because that row is `locked: true` and renders permanently on regardless of what a lookup against
 * stored state would answer. That is CLAUDE.md hard rule #3 -- "HIGH-risk actions never get an
 * auto-allow, at any point, for any reason" -- reaching this corner of the UI: an OS notification on
 * a HIGH approval is what "awaiting input" means, and there is no auto-allow for it to degrade into.
 * This schema has no `high` field for a value to round-trip through, so no code path -- not even a
 * malformed `PUT` body -- can produce one for `NotificationsPanel` to read back. See that
 * component's own comment for the structural (not just visual) half of this guarantee.
 *
 * ## What this does not yet do
 *
 * `sendOsNotification` (`apps/desktop/electron/os-notification.ts`) is a real, tested adapter whose
 * four kinds -- `high-approval`, `refusal`, `stack-signoff`, `medium-late` -- already match this
 * panel's rows one-for-one. Nothing calls it yet: the #97 (MEDIUM inline approval), #98 (HIGH
 * publish gate) and #99 (stack approval) flows this ticket checked do not fire it, and there is no
 * tray-badge or sound implementation anywhere in `apps/desktop/electron` today. Wiring each trigger
 * point to check this store before calling (or not calling) `sendOsNotification` is real, separate
 * scope -- see this repo's "no fabricated data" discipline (CLAUDE.md) for why that is stated here
 * rather than implied away, the same honest note `pipenzo-concurrency-v1.ts` and
 * `pipenzo-capture-settings-v1.ts` each carry for their own not-yet-enforced fields. This schema
 * only makes the four preferences real, persisted and round-tripped, matching the split those two
 * files already drew between "a setting" and "the enforcement that reads it."
 */

export const PIPENZO_NOTIFY_REFUSAL_DEFAULT = true;
export const PIPENZO_NOTIFY_MEDIUM_DEFAULT = true;
export const PIPENZO_NOTIFY_BADGE_DEFAULT = true;
export const PIPENZO_NOTIFY_SOUND_DEFAULT = false;

/** The full settings record, as `GET /v2/pipenzo/notification-settings` answers with. `.strict()`
 *  like every other Pipenzo wire shape. Deliberately has no `high` field -- see the module comment. */
export const pipenzoNotificationSettingsV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    refusal: z.boolean(),
    medium: z.boolean(),
    badge: z.boolean(),
    sound: z.boolean(),
  })
  .strict();
export type PipenzoNotificationSettingsV1 = z.infer<typeof pipenzoNotificationSettingsV1Schema>;

/**
 * What `PUT /v2/pipenzo/notification-settings` accepts: a partial update, merged onto the stored
 * record -- same reasoning `pipenzoCaptureSettingsUpdateV1Schema` already documents: each toggle is
 * switched independently, so flipping one must not require resending the other three, and an empty
 * `{}` is refused rather than silently succeeding as a no-op. `.strict()` means a caller that sends
 * `{ high: false }` is rejected as an unrecognised field, not silently ignored -- there is no way to
 * even ask to turn HIGH off, let alone succeed at it.
 */
export const pipenzoNotificationSettingsUpdateV1Schema = z
  .object({
    refusal: z.boolean().optional(),
    medium: z.boolean().optional(),
    badge: z.boolean().optional(),
    sound: z.boolean().optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.refusal !== undefined ||
      value.medium !== undefined ||
      value.badge !== undefined ||
      value.sound !== undefined,
    { message: 'at least one of refusal, medium, badge or sound must be given' },
  );
export type PipenzoNotificationSettingsUpdateV1 = z.infer<
  typeof pipenzoNotificationSettingsUpdateV1Schema
>;
