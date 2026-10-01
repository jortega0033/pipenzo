import { useCallback, useEffect, useRef, useState } from 'react';
import type { PipenzoNotificationSettingsV1 } from '@agent-dock/shared';
import { getBridge } from '../bridge.js';
import { LoadLine } from '../components/primitives/LoadLine.js';
import { Notice } from '../components/primitives/Notice.js';
import { Toggle } from '../components/primitives/Toggle.js';

/** A settings-update payload: exactly one of the four real preferences, never `high` -- there is no
 *  field for it in `PipenzoNotificationSettingsUpdateV1` for a caller to even attempt. */
type NotificationUpdate =
  | { refusal: boolean }
  | { medium: boolean }
  | { badge: boolean }
  | { sound: boolean };

/**
 * Settings' Notifications panel (Pipenzo issue #129, split of epic #6's "Polish") --
 * `Settings.dc.html`'s five-row `NOTIFS` seed, now real: four switches that round-trip through
 * `PipenzoNotificationSettingsStore`, one row that cannot be switched at all, and the two-line
 * notice stating the facts neither row's own copy can carry.
 *
 * ## Why the HIGH row is not just visually locked
 *
 * CLAUDE.md hard rule #3 -- "HIGH-risk actions never get an auto-allow, at any point, for any
 * reason" -- is a safety property, not a style choice, and a toggle that merely *looked* disabled
 * while some state variable underneath still said `false` would not honor it. Three separate layers
 * make "HIGH is always on" true rather than performed:
 *
 * 1. **The wire schema.** `pipenzoNotificationSettingsV1Schema`/`...UpdateV1Schema` (shared package)
 *    have no `high` field at all. There is no request body, malformed or otherwise, that the daemon
 *    route would accept as "turn HIGH off" -- `.strict()` rejects an unrecognised `high` key outright.
 * 2. **The store.** `PipenzoNotificationSettingsStore` validates every read and write against that
 *    same schema, so a hand-edited state file with a `"high": false` key is parsed as the ordinary
 *    four fields plus one ignored extra -- `.strict()` means the *file* parse would actually fail
 *    closed to defaults, never fail open to a HIGH preference nothing asked for.
 * 3. **This component.** The HIGH row below is rendered from a literal `locked` prop on `Toggle`,
 *    never from `settings.<something>` -- there is no `settings.high` to read in the first place.
 *    `Toggle`'s own implementation (`components/primitives/Toggle.tsx`) forces `aria-checked`/the
 *    `on` class whenever `locked` is true regardless of what `checked` it was given, disables the
 *    `<button>` so neither a mouse click nor a keyboard activation can reach its `onClick`, and this
 *    row's own `onChange` is a no-op (`() => {}`) on top of that -- three independent reasons the
 *    click handler that flips every other row's preference can never run for this one. See
 *    `NotificationsPanel.test.tsx` for the test that drives every one of these paths and confirms
 *    none of them can turn the row off.
 *
 * ## Why only four fields round-trip, and what still does not fire
 *
 * `sendOsNotification` (`apps/desktop/electron/os-notification.ts`) already exists as a real, tested
 * adapter whose four kinds match this panel's rows one-for-one, but nothing calls it from the #97
 * MEDIUM-approval, #98 HIGH-publish-gate or #99 stack-approval flows yet, and there is no tray-badge
 * or sound implementation anywhere in `apps/desktop/electron` today. This panel makes the four
 * preferences real and persisted; wiring each trigger point to check them before calling (or not
 * calling) `sendOsNotification` is separate, larger scope this ticket does not take on -- see this
 * repo's "no fabricated data" discipline (CLAUDE.md), and `pipenzo-notification-settings-v1.ts`'s
 * own module comment for the same honest note stated once for the whole stack.
 */
export function NotificationsPanel() {
  const [settings, setSettings] = useState<PipenzoNotificationSettingsV1 | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | undefined>(undefined);
  const [reloadKey, setReloadKey] = useState(0);
  const [saveError, setSaveError] = useState<string | undefined>(undefined);
  /** Guards against a second toggle click landing while the first save is still in flight -- the
   *  same in-flight-latch shape `ConcurrencyPanel.save()` uses. */
  const savingRef = useRef(false);
  /** The last value this panel actually knows the daemon holds -- set on every successful load or
   *  save, never on the optimistic update below. A failed save reverts `settings` to this, same
   *  reasoning `ConcurrencyPanel`'s own `confirmedRef` documents. */
  const confirmedRef = useRef<PipenzoNotificationSettingsV1 | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    setLoadError(undefined);
    setSettings(undefined);
    void getBridge()
      .pipenzoNotificationSettings()
      .then((result) => {
        if (cancelled) return;
        confirmedRef.current = result;
        setSettings(result);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setLoadError(
          error instanceof Error ? error.message : 'could not read your notification settings',
        );
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const save = useCallback((update: NotificationUpdate) => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaveError(undefined);
    void getBridge()
      .pipenzoUpdateNotificationSettings(update)
      .then((result) => {
        savingRef.current = false;
        // The daemon's own answer, not the optimistic value this call sent -- same reasoning
        // `ConcurrencyPanel.save()` documents for why a write's response, not a locally assembled
        // guess, is what gets rendered next.
        confirmedRef.current = result;
        setSettings(result);
      })
      .catch((error: unknown) => {
        savingRef.current = false;
        setSaveError(
          error instanceof Error ? error.message : 'could not save that notification preference',
        );
        // Revert the optimistic update -- see `confirmedRef`'s own comment.
        setSettings(confirmedRef.current);
      });
  }, []);

  return (
    <div className="form-panel">
      <div className="fieldset">
        <span className="f-lbl">Notifications</span>

        {loadError !== undefined ? (
          <Notice
            tone="danger"
            icon="warning"
            title="Could not read your notification settings"
            actions={[{ label: 'Try again', onClick: () => setReloadKey((key) => key + 1) }]}
          >
            Nothing has been changed.
          </Notice>
        ) : settings === undefined ? (
          <LoadLine>Reading your notification settings…</LoadLine>
        ) : (
          <>
            <span className="set-sub">
              Notification is risk-graded, not uniform. What follows is the configurable part; the
              two lines under it are the part that is not.
            </span>

            <div className="set-row">
              <span className="set-text">
                <span className="set-name">HIGH-risk approvals</span>
                <span className="set-sub">
                  The publish gate, and anything else irreversible or off-machine. Always an OS
                  notification, always a mandatory reject reason, never an auto-allow.
                </span>
              </span>
              <span className="set-ctl">
                <span className="set-lock">always on</span>
                <Toggle
                  checked
                  locked
                  onChange={() => {}}
                  aria-label="HIGH-risk approvals — always on, not configurable"
                />
              </span>
            </div>

            <div className="set-row">
              <span className="set-text">
                <span className="set-name">A refusal, or a stack awaiting sign-off</span>
                <span className="set-sub">
                  Both count as awaiting input: nothing is running and nothing will run until a
                  person answers.
                </span>
              </span>
              <span className="set-ctl">
                <Toggle
                  checked={settings.refusal}
                  onChange={(next) => {
                    setSettings({ ...settings, refusal: next });
                    save({ refusal: next });
                  }}
                  aria-label="A refusal, or a stack awaiting sign-off"
                />
              </span>
            </div>

            <div className="set-row">
              <span className="set-text">
                <span className="set-name">A MEDIUM still blocking after 60 seconds</span>
                <span className="set-sub">
                  A MEDIUM that resolves quickly stays quiet. One that silently halts a whole run
                  for an hour is the failure mode notification exists for.
                </span>
              </span>
              <span className="set-ctl">
                <Toggle
                  checked={settings.medium}
                  onChange={(next) => {
                    setSettings({ ...settings, medium: next });
                    save({ medium: next });
                  }}
                  aria-label="A MEDIUM still blocking after 60 seconds"
                />
              </span>
            </div>

            <div className="set-row">
              <span className="set-text">
                <span className="set-name">Tray badge when a ticket needs me</span>
                <span className="set-sub">
                  A count on the dock or tray icon, batched to one repaint per tick.
                </span>
              </span>
              <span className="set-ctl">
                <Toggle
                  checked={settings.badge}
                  onChange={(next) => {
                    setSettings({ ...settings, badge: next });
                    save({ badge: next });
                  }}
                  aria-label="Tray badge when a ticket needs me"
                />
              </span>
            </div>

            <div className="set-row">
              <span className="set-text">
                <span className="set-name">Sound</span>
              </span>
              <span className="set-ctl">
                <Toggle
                  checked={settings.sound}
                  onChange={(next) => {
                    setSettings({ ...settings, sound: next });
                    save({ sound: next });
                  }}
                  aria-label="Sound"
                />
              </span>
            </div>

            {saveError !== undefined && (
              <Notice tone="danger" icon="warning" title="Could not save that setting">
                {saveError}
              </Notice>
            )}
          </>
        )}
      </div>

      <Notice quiet icon="info" title="Two things here are not settings">
        LOW actions never notify: they auto-proceed inside the owned worktree and are logged as a
        passive line. And nothing that leaves the machine can be auto-allowed at any risk level —
        publishing is permanently a HIGH action, which is why the row above it has no switch.
      </Notice>
    </div>
  );
}
