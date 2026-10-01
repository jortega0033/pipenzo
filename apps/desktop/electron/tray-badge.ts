import type { PipenzoLaneV1 } from '@agent-dock/shared';
import { ticketsByLane } from '../src/pipenzo/board-lanes.js';
import { badgeLabelForCount } from './badge-overlay.js';

/**
 * Drives the Windows tray badge (issue #151): a numeral on the tray icon equal to the live
 * Needs-human lane count -- the same count the board's Needs-human column already shows. This module
 * imports `ticketsByLane` from `board-lanes.ts` rather than re-deriving a lane from labels itself,
 * exactly so it cannot compute a second "needs me" number that drifts from the board's (AC-7).
 *
 * ## Why this re-reads the ticket list instead of tallying the phase-event stream itself
 *
 * `usePipenzoTickets` (the board's own live-ticket hook, `apps/desktop/src/pipenzo/
 * use-pipenzo-tickets.ts`) does not reconstruct a ticket's lane by replaying phase events -- it
 * debounces on each event and then re-reads `GET /v2/pipenzo/tickets` for a fresh, authoritative
 * snapshot. This module mirrors exactly that, for the same two reasons that hook's own comment gives:
 * the phase-event stream's replay buffer is bounded (`pipenzo-phase-events.ts`'s
 * `MAX_RETAINED_EVENTS`), so a ticket whose only transition fell out of that window would never be
 * seen by a listener that only tallied events; and a closed ticket gets no explicit "removed" event
 * at all -- it just stops appearing in the list. Re-reading the snapshot sidesteps both gaps instead
 * of growing a second, more fragile way to track ticket state.
 *
 * `PHASE_EVENT_DEBOUNCE_MS` below intentionally matches `use-pipenzo-tickets.ts`'s own constant
 * rather than importing it: that module is renderer-only React (`useState`/`useEffect`) with no
 * runtime in the Electron main process this one runs in. The daemon's reconciler can fan one poll
 * tick out into a burst of near-simultaneous events, and debouncing collapses that burst into exactly
 * one re-read and one repaint (AC-4), the same way it collapses into one board re-render.
 */
const PHASE_EVENT_DEBOUNCE_MS = 300;

const NEEDS_HUMAN_LANE: PipenzoLaneV1 = 'needs-human';

/** Narrower than `PipenzoTicketListV1`: this module only ever reads each ticket's lane, so tests
 *  build fixtures with just that field, and `client.v2.pipenzo.listTickets()`'s real, fuller answer
 *  satisfies this structurally with no cast needed. */
export interface TrayBadgeTicketList {
  readonly tickets: readonly { readonly lane: PipenzoLaneV1 }[];
}

/** Narrower than `PipenzoNotificationSettingsV1` for the same reason. */
export interface TrayBadgeNotificationSettings {
  readonly badge: boolean;
}

export interface TrayBadgeDeps {
  /** Injectable for tests; `main.ts` passes `process.platform`. Gates every effect below on Windows
   *  (AC-8) -- on any other platform this controller stays entirely inert rather than throwing,
   *  since Electron's tray/badge APIs differ by platform and a real macOS/Linux treatment is its own,
   *  explicitly out-of-scope ticket. */
  platform: NodeJS.Platform;
  listTickets: () => Promise<TrayBadgeTicketList>;
  getNotificationSettings: () => Promise<TrayBadgeNotificationSettings>;
  /** The one Electron-touching seam: paints the tray icon, or resets it to the plain icon when
   *  `label` is `undefined`. Left to the caller (`main.ts`) so this module needs no `electron` import
   *  and no live `Tray`/`NativeImage` to run under test. */
  paint: (label: string | undefined) => void;
  /** Logged, never thrown -- a daemon hiccup reading tickets or settings must not take the tray icon,
   *  or the app, down. */
  onError?: (error: unknown) => void;
  /** Overrides `PHASE_EVENT_DEBOUNCE_MS`; tests pass 0 to assert synchronously-ish. */
  debounceMs?: number;
}

export class TrayBadgeController {
  readonly #deps: TrayBadgeDeps;
  #enabled = true;
  #lastCount = 0;
  #lastPaintedLabel: string | undefined;
  #hasPainted = false;
  #debounceTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(deps: TrayBadgeDeps) {
    this.#deps = deps;
  }

  get #isWindows(): boolean {
    return this.#deps.platform === 'win32';
  }

  /**
   * Seeds both the Settings toggle and the current count from scratch, then paints once. Call this
   * whenever the daemon client becomes available -- first start and every reconnect -- the same
   * "ask once on mount, then react to events" shape `usePipenzoTickets` uses for the board.
   */
  async start(): Promise<void> {
    if (!this.#isWindows) return;
    await Promise.all([this.#refreshEnabled(), this.#refreshCount()]);
    this.#repaint();
  }

  /**
   * Call on every forwarded `ticket.phase_changed` event. Debounced per the module doc comment above
   * -- a burst of events within one poll tick collapses into exactly one re-read and one repaint.
   */
  onPhaseEvent(): void {
    if (!this.#isWindows) return;
    if (this.#debounceTimer !== undefined) clearTimeout(this.#debounceTimer);
    this.#debounceTimer = setTimeout(() => {
      this.#debounceTimer = undefined;
      void this.#refreshCount().then(() => this.#repaint());
    }, this.#deps.debounceMs ?? PHASE_EVENT_DEBOUNCE_MS);
  }

  /**
   * Call right after Settings' badge toggle is written, with the daemon's own merged answer -- never
   * the raw IPC input -- so a partial update (e.g. `{ sound: true }`, `badge` unspecified) is never
   * misread as "badge: undefined -> off". Repaints immediately from the last-known count rather than
   * waiting on a refetch (AC-5: suppression is immediate, and it never silently reappears stale while
   * off, because the very next repaint -- from this call or the next phase event -- re-checks it).
   */
  setEnabled(enabled: boolean): void {
    if (!this.#isWindows) return;
    this.#enabled = enabled;
    this.#repaint();
  }

  /** Clears any pending debounce timer. Call on app quit so nothing fires after the tray (and its
   *  daemon client) is gone. */
  stop(): void {
    if (this.#debounceTimer !== undefined) clearTimeout(this.#debounceTimer);
    this.#debounceTimer = undefined;
  }

  async #refreshEnabled(): Promise<void> {
    try {
      this.#enabled = (await this.#deps.getNotificationSettings()).badge;
    } catch (error) {
      this.#deps.onError?.(error);
    }
  }

  async #refreshCount(): Promise<void> {
    try {
      const list = await this.#deps.listTickets();
      this.#lastCount = ticketsByLane(list.tickets)[NEEDS_HUMAN_LANE].length;
    } catch (error) {
      this.#deps.onError?.(error);
    }
  }

  /** AC-4's "one repaint" also means not repainting when nothing actually changed -- this is what
   *  stops an unrelated label edit that leaves the count the same from flickering the tray icon. */
  #repaint(): void {
    const label = this.#enabled ? badgeLabelForCount(this.#lastCount) : undefined;
    if (this.#hasPainted && label === this.#lastPaintedLabel) return;
    this.#hasPainted = true;
    this.#lastPaintedLabel = label;
    this.#deps.paint(label);
  }
}
