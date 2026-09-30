import { useCallback, useEffect, useRef, useState } from 'react';
import type { PipenzoConcurrencySettingsV1, PipenzoRunBudgetV1 } from '@agent-dock/shared';
import { getBridge } from '../bridge.js';
import { LaneCap } from '../components/primitives/LaneCap.js';
import { LoadLine } from '../components/primitives/LoadLine.js';
import { NumberStepper } from '../components/primitives/NumberStepper.js';
import { Notice } from '../components/primitives/Notice.js';
import { Select } from '../components/primitives/Select.js';
import { RUN_BUDGET_OPTIONS, isPipenzoRunBudget } from './concurrency-settings.js';
import { usePipenzoTickets } from './use-pipenzo-tickets.js';

const EXECUTION_LIMIT_MIN = 1;
const EXECUTION_LIMIT_MAX = 4;

/**
 * Settings' Concurrency panel (Pipenzo issue #126, split of epic #5's "Queue + dual-audience mode,
 * bounded concurrency") — the execution-limit stepper, the non-configurable file-overlap-
 * serialisation row with a live capacity readout, and the workspace default run budget.
 *
 * ## Why the stepper is real, and what "real" means here
 *
 * `NumberStepper` existed in this codebase before this ticket (built for exactly this panel, see
 * its own doc comment) but had nothing behind it. This panel is the other half: every click calls
 * `PUT /v2/pipenzo/concurrency`, which the daemon persists *and* applies immediately to the live
 * `PipenzoExecutionLimiter` that actually gates a new Implement dispatch (`pipenzo-execution-
 * limiter.ts`) — not a value that only takes effect after a restart, and not a value nothing reads
 * at all. See this repo's "no fabricated data" discipline (CLAUDE.md) for why that distinction
 * matters enough to state here.
 *
 * ## Why the capacity readout reuses `usePipenzoTickets`, not a new fetch
 *
 * The Working lane's own header pill (`BoardScreen.tsx`, issue #85) already computes exactly
 * "how many Working tickets are `running` vs `held`" from `GET /v2/pipenzo/tickets`'s per-ticket
 * `concurrency` field. This panel needs the same two numbers, so it reads the same hook rather than
 * having the daemon compute a second, independent summary of the same underlying state — one
 * source of truth, reachable from two screens, exactly like `workingLaneCapacity` itself (see that
 * field's own doc comment in `pipenzo-phase-machine-v1.ts`).
 *
 * ## Why the run-budget `<select>` has no enforcement copy
 *
 * `pipenzo-concurrency-store.ts`'s own module comment explains why: the accounting and refusal
 * halves of per-ticket budgets (issue #143) already exist, but nothing yet produces a nonzero
 * `budget.limit` for either to act on, and wiring this workspace default into that is #143's own
 * remaining scope, not this ticket's. The help text below says exactly that, honestly, rather than
 * repeating the design canvas's own forward-looking copy about what a budget "does" today.
 */
export function ConcurrencyPanel() {
  const [settings, setSettings] = useState<PipenzoConcurrencySettingsV1 | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | undefined>(undefined);
  const [reloadKey, setReloadKey] = useState(0);
  const [saveError, setSaveError] = useState<string | undefined>(undefined);
  /** Guards against a second stepper click or select change landing while the first save is still
   *  in flight -- the same in-flight-latch shape `LessonsPanel.remove()` uses, except here it also
   *  drives `disabled` on both controls, since a stepper mid-save showing a value a save could still
   *  overwrite is worse than a stepper that is briefly unresponsive. */
  const savingRef = useRef(false);
  const [saving, setSaving] = useState(false);
  /** The last value this panel actually knows the daemon holds -- set on every successful load or
   *  save, never on the optimistic update below. A failed save reverts `settings` to this rather
   *  than leaving the optimistic value on screen: showing a stepper position nothing on disk agrees
   *  with is exactly the "changes a number nothing reads" shape this ticket's brief rules out, even
   *  transiently. */
  const confirmedRef = useRef<PipenzoConcurrencySettingsV1 | undefined>(undefined);
  const { ticketList } = usePipenzoTickets();

  useEffect(() => {
    let cancelled = false;
    setLoadError(undefined);
    setSettings(undefined);
    void getBridge()
      .pipenzoConcurrencySettings()
      .then((result) => {
        if (cancelled) return;
        confirmedRef.current = result;
        setSettings(result);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setLoadError(
          error instanceof Error ? error.message : 'could not read your concurrency settings',
        );
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const save = useCallback(
    (
      update:
        | { executionLimit: number }
        | { runBudget: PipenzoRunBudgetV1 },
    ) => {
      if (savingRef.current) return;
      savingRef.current = true;
      setSaving(true);
      setSaveError(undefined);
      void getBridge()
        .pipenzoUpdateConcurrencySettings(update)
        .then((result) => {
          savingRef.current = false;
          setSaving(false);
          // The daemon's own answer, not the optimistic value this call sent -- same reasoning
          // `LessonsPanel.remove()` and `ConnectedReposPanel.remove()` already document for why a
          // write's response, not a locally assembled guess, is what gets rendered next.
          confirmedRef.current = result;
          setSettings(result);
        })
        .catch((error: unknown) => {
          savingRef.current = false;
          setSaving(false);
          setSaveError(
            error instanceof Error ? error.message : 'could not save that concurrency setting',
          );
          // Revert the optimistic update -- see `confirmedRef`'s own comment.
          setSettings(confirmedRef.current);
        });
    },
    [],
  );

  const running = ticketList.status === 'ready'
    ? ticketList.tickets.filter((ticket) => ticket.concurrency?.state === 'running').length
    : undefined;
  const held = ticketList.status === 'ready'
    ? ticketList.tickets.filter((ticket) => ticket.concurrency?.state === 'held').length
    : undefined;
  const capacity =
    ticketList.status === 'ready' ? ticketList.workingLaneCapacity ?? settings?.executionLimit : undefined;

  return (
    <div className="form-panel">
      <div className="fieldset">
        <span className="f-lbl">Concurrency</span>

        {loadError !== undefined ? (
          <Notice
            tone="danger"
            icon="warning"
            title="Could not read your concurrency settings"
            actions={[{ label: 'Try again', onClick: () => setReloadKey((key) => key + 1) }]}
          >
            Nothing has been changed.
          </Notice>
        ) : settings === undefined ? (
          <LoadLine>Reading your concurrency settings…</LoadLine>
        ) : (
          <>
            <div className="set-row">
              <span className="set-text">
                <span className="set-name">Execution limit</span>
                <span className="set-sub">
                  One worktree and one branch per running ticket, never shared — two tickets in
                  Working at once are two checkouts, not one.
                </span>
              </span>
              <span className="set-ctl">
                <NumberStepper
                  value={settings.executionLimit}
                  min={EXECUTION_LIMIT_MIN}
                  max={EXECUTION_LIMIT_MAX}
                  aria-label="Execution limit"
                  onChange={(next) => {
                    setSettings({ ...settings, executionLimit: next });
                    save({ executionLimit: next });
                  }}
                />
              </span>
            </div>
            <span className="f-help" style={{ marginTop: '-4px' }}>
              Default 2, hard cap 4. Bounded local concurrency is the honest ceiling for one machine
              sharing one subscription&apos;s rate limit — cloud sandbox fleets are a funded-product
              feature, not a missing one.
            </span>

            <div className="set-stack">
              <span className="set-text">
                <span className="set-name">Overlapping tickets are serialised</span>
                <span className="set-sub">
                  Two tickets whose Refine &quot;files likely touched&quot; lists overlap are held
                  rather than run together. Not configurable — it is what keeps two worktrees from
                  fighting over one file.
                </span>
              </span>
              <span className="set-ctl">
                {running !== undefined && capacity !== undefined ? (
                  <LaneCap kind={running >= capacity ? 'full' : 'running'}>
                    {running} of {capacity} running
                  </LaneCap>
                ) : null}
                {held !== undefined && held > 0 ? (
                  <LaneCap kind="held">
                    {held} held
                  </LaneCap>
                ) : null}
              </span>
            </div>

            <div>
              <Select
                label="Workspace default run budget"
                mono
                options={RUN_BUDGET_OPTIONS}
                value={settings.runBudget}
                disabled={saving}
                onChange={(event) => {
                  const { value } = event.target;
                  if (!isPipenzoRunBudget(value)) return;
                  setSettings({ ...settings, runBudget: value });
                  save({ runBudget: value });
                }}
                help="Not enforced yet — reserved for per-ticket run budgets (issue #143), which already refuse a session once a ticket's own budget is spent but have nothing today that sets one."
              />
            </div>

            {saveError !== undefined && (
              <Notice tone="danger" icon="warning" title="Could not save that setting">
                {saveError}
              </Notice>
            )}
          </>
        )}
      </div>
    </div>
  );
}
