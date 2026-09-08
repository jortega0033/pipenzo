import {
  DeviceFlowError,
  type DeviceCodeGrant,
  type DeviceFlowFailureReason,
} from './github-device-flow.js';
import type { PipenzoDeviceCodeV1, PipenzoDeviceFailureReasonV1 } from '@agent-dock/shared';

/**
 * The one in-flight device-code sign-in, and the rules about when it may store a credential
 * (issue #114).
 *
 * ## Why this is a module rather than four variables in `main.ts`
 *
 * The single most security-relevant line in this feature is the guard that refuses to store a
 * credential belonging to a superseded or cancelled flow. In `main.ts` it sat inside the Electron
 * entry point, where no test can reach it — and the first review found that the guard beside it was
 * bypassable, precisely because nothing exercised the lifecycle. A state machine that decides
 * whether to keep a `repo`-scoped token has to be a thing a test can drive.
 *
 * ## The concurrency rule, which is the part that was wrong
 *
 * A grant is minted by an `await`. Keying "is a flow already running?" on the *grant* leaves the
 * whole network round trip uncovered: every call arriving before the first one resolves sees no
 * grant, passes the guard, and mints its own. That is not a theoretical race — flipping between
 * Connect's two steps during one slow round trip reaches it, and a renderer looping the channel
 * reaches it a thousand times. Each extra flow also overwrote the previous `AbortController`,
 * orphaning a poll loop that then ran for the grant's full lifetime with nothing able to stop it.
 *
 * So the latch is the **pending promise**, not the grant, and a second caller joins the first
 * rather than starting anything.
 */

export interface DeviceFlowSessionDeps {
  /** Asks GitHub for a code. Injected whole so a test never needs a network or a fake server. */
  readonly requestCode: () => Promise<DeviceCodeGrant>;
  /** Polls to completion. Rejects with a `DeviceFlowError` for every non-credential outcome. */
  readonly poll: (
    grant: DeviceCodeGrant,
    options: { signal: AbortSignal },
  ) => Promise<{ token: string; login: string }>;
  /**
   * Whether this machine can keep a credential at all, checked *before* a code is requested.
   *
   * In main rather than only in the renderer, and that is the whole point of it being here: a
   * disabled button is a suggestion, not a refusal, and the cost of being wrong is issuing a live
   * `repo` token that a public client has no way to revoke.
   */
  readonly canStore: () => boolean;
  /** Throws `GitHubTokenVaultError` when the machine cannot keep it. */
  readonly store: (credential: { token: string; login: string }) => void;
  /** Whether a vault error means "nowhere to keep it" rather than "this value is malformed". */
  readonly isStorageFailure: (error: unknown) => boolean;
  /** Called exactly once per completed sign-in, with the outcome the renderer should see. */
  readonly report: (
    outcome: { state: 'connected' } | { state: 'failed'; reason: PipenzoDeviceFailureReasonV1 },
  ) => void;
  /** Called after a credential lands, to hand the new token to a freshly spawned daemon. */
  readonly onStored: () => void;
}

/**
 * Maps a flow failure onto the wire enum. Every branch is named rather than defaulted, so a new
 * `DeviceFlowFailureReason` is a type error here instead of silently becoming `unreachable`.
 */
export function toWireFailure(reason: DeviceFlowFailureReason): PipenzoDeviceFailureReasonV1 {
  switch (reason) {
    case 'expired':
      return 'expired';
    case 'denied':
      return 'denied';
    case 'cancelled':
      return 'cancelled';
    case 'not_configured':
      return 'not_configured';
    case 'unreachable':
      return 'unreachable';
  }
}

export class DeviceFlowSession {
  readonly #deps: DeviceFlowSessionDeps;
  #grant: DeviceCodeGrant | undefined;
  #abort: AbortController | undefined;
  /** The latch. Held across the `requestCode` round trip, which the grant alone cannot cover. */
  #pending: Promise<DeviceCodeGrant> | undefined;

  constructor(deps: DeviceFlowSessionDeps) {
    this.#deps = deps;
  }

  /** What the renderer may see of the live grant: never the device code. */
  #wire(grant: DeviceCodeGrant): PipenzoDeviceCodeV1 {
    // Built field by field, never spread. A field added to `DeviceCodeGrant` tomorrow -- the device
    // code is already one of them -- must not be able to reach a window by accident.
    return {
      userCode: grant.userCode,
      verificationUri: grant.verificationUri,
      expiresAt: grant.expiresAt,
    };
  }

  /** The URL to open, or `undefined` when there is no live grant. Always main's own copy. */
  get verificationUri(): string | undefined {
    return this.#grant?.verificationUri;
  }

  #end(): void {
    this.#abort?.abort();
    this.#abort = undefined;
    this.#grant = undefined;
  }

  /**
   * Starts a sign-in, or joins the one already running.
   *
   * Three cases, in order. A live unexpired grant is returned unchanged — the user may be looking
   * at that code and part-way through typing it, and re-minting on every call is how this channel
   * becomes a way to hammer GitHub into rate-limiting the client. A start already in flight is
   * *joined*, not duplicated. Only a genuinely idle session requests anything.
   */
  async start(): Promise<PipenzoDeviceCodeV1> {
    const live = this.#grant;
    if (live && Date.now() < live.expiresAt) return this.#wire(live);
    if (this.#pending) return this.#wire(await this.#pending);

    // Refused before a code is requested, not after the user has authorized one. Otherwise the
    // whole flow runs, GitHub issues a real `repo` token, and only then does it turn out there is
    // nowhere to put it -- leaving a live credential on the account that this app cannot revoke.
    if (!this.#deps.canStore()) {
      throw new DeviceFlowError(
        'unreachable',
        'this machine has no usable credential store, so a sign-in could not be saved',
      );
    }

    this.#end();
    const pending = this.#deps.requestCode();
    this.#pending = pending;
    let grant: DeviceCodeGrant;
    try {
      grant = await pending;
    } finally {
      // Released whether it resolved or threw, or the next start would join a dead promise.
      if (this.#pending === pending) this.#pending = undefined;
    }

    const abort = new AbortController();
    this.#grant = grant;
    this.#abort = abort;
    // Not awaited: the human is in their browser for most of this, and holding the IPC call open
    // across it would tie the flow's lifetime to a renderer that may reload.
    void this.#run(grant, abort.signal);
    return this.#wire(grant);
  }

  /** Ends the sign-in at the user's request, and says so. Idempotent. */
  cancel(): void {
    if (!this.#grant && !this.#pending) return;
    this.#end();
    this.#deps.report({ state: 'failed', reason: 'cancelled' });
  }

  /** Ends it silently — shutdown, where reporting to a window that is going away is pointless. */
  abandon(): void {
    this.#end();
  }

  async #run(grant: DeviceCodeGrant, signal: AbortSignal): Promise<void> {
    let credential: { token: string; login: string };
    try {
      credential = await this.#deps.poll(grant, { signal });
    } catch (error) {
      // The same identity check as the success path, and for the same reason: a superseded flow
      // must not narrate the UI that now belongs to its successor.
      if (signal.aborted || this.#grant !== grant) return;
      this.#end();
      this.#deps.report({
        state: 'failed',
        reason: error instanceof DeviceFlowError ? toWireFailure(error.reason) : 'unreachable',
      });
      return;
    }

    // Between the last poll and here the user may have hit Cancel, or a newer flow may have taken
    // over. A credential arriving after either is one the user did not consent to keep.
    if (signal.aborted || this.#grant !== grant) return;

    try {
      this.#deps.store(credential);
    } catch (error) {
      this.#end();
      // A vault that cannot encrypt is a different failure from a vault that rejected the value.
      // Reporting a malformed login as "this machine has nowhere to keep the token" would send the
      // user to debug their keyring for a problem that is not there.
      this.#deps.report({
        state: 'failed',
        reason: this.#deps.isStorageFailure(error) ? 'storage_unavailable' : 'unreachable',
      });
      return;
    }

    this.#end();
    this.#deps.onStored();
    this.#deps.report({ state: 'connected' });
  }
}
