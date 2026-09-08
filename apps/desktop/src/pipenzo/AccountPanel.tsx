import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { ProviderStatusV2 } from '@agent-dock/shared';
import { getBridge } from '../bridge.js';
import { Button } from '../components/primitives/Button.js';
import { Dialog } from '../components/primitives/Dialog.js';
import { Icon } from '../components/primitives/Icon.js';
import { LoadLine } from '../components/primitives/LoadLine.js';
import { Notice } from '../components/primitives/Notice.js';
import {
  GITHUB_AUTHORIZED_APPS_URL,
  REQUESTED_OAUTH_SCOPE,
  accountMonogram,
  connectionChip,
  isRunningOnInheritedToken,
  providerRows,
  storedOnLabel,
  tokenLocationLabel,
  unavailableReasonLabel,
} from './account.js';
import { useAsyncAction } from './use-async-action.js';
import { useGitHubConnection } from './use-github-connection.js';

/**
 * Settings' Account / Providers / Disconnect panel (issue #130).
 *
 * ## Why the "gh CLI" row does not say "detected"
 *
 * The canvas draws `gh CLI — detected · gh stack only`, and nothing behind it exists. `gh` is
 * spawned nowhere in this product: the only mentions of it under `apps/` are comments in
 * `github-client.ts` and `publish-service.ts` saying it is deliberately *not* invoked, and the
 * `gh stack` work those comments defer to is post-MVP.
 *
 * So a probe was the wrong build. It would spawn a subprocess and resolve a binary off `PATH` to
 * report on a tool no code path uses — new surface bought for a decoration. Worse, "detected" sits
 * two rows under "Token location" in a panel whose entire job is to say where the credential lives,
 * and a user reading the two together would reasonably conclude `gh` is somewhere in the publish
 * path, holding their token. It is not, and the row now says so.
 *
 * Kept as an honest negative rather than dropped, because "does `gh` have anything to do with my
 * token?" is a question this panel is the right place to answer, and the answer is load-bearing: it
 * is the same promise as "no provider subprocess receives it", one line further on.
 *
 * ## Why `source` gets a notice and not just a row
 *
 * `PipenzoGitHubConnectionV1` carries `state` (what the vault holds) and `source` (which credential
 * the *running daemon* was handed), and the two can disagree. `daemon-environment.ts` is explicit
 * that the ambiguity worth preventing is *silent* precedence, and equally explicit that until
 * something renders this field, "you are running on the development fallback, not the account you
 * connected" reaches a console warning and nothing a user sees — "the field is the mechanism; the
 * surface is still owed". This panel is that surface, so the environment case is raised rather than
 * printed in a row where it would read as trivia.
 *
 * ## Why Disconnect confirms first, and why a ref guards it
 *
 * It is not "forget a token". The daemon is handed its credential once at spawn, so forgetting one
 * restarts the daemon, and that restart deliberately bypasses `killDaemon`'s graceful
 * `sessions.cancelAll` — on Windows `child.kill()` is `TerminateProcess`, so in-flight sessions die
 * uncancelled. `restartDaemonForCredentialChange` argued that was acceptable *because connecting
 * and disconnecting are pre-app actions taken before any ticket is running*, and said outright it
 * "would not be if this were ever reachable mid-run". A button in Settings is exactly that. The
 * premise is filed as #224; what this component owes meanwhile is to stop being one
 * click, and to name the consequence before it happens rather than after.
 *
 * The ref is not belt-and-braces. `Button` deliberately does not set the `disabled` attribute while
 * merely `pending` — it drops the interaction through `onClick={pending ? undefined : onClick}` —
 * and `pending`, like every other guard of this shape in this codebase, is state that has not
 * committed yet when a second click lands in the same batch. `useAsyncAction` does not close it
 * either: its `callIdRef` decides which *outcome* commits, not whether a second call starts, so two
 * `run()`s are two real daemon restarts. Repeating this particular channel is how #223's sibling
 * bug went: an unbounded restart loop that kills every running session on each pass.
 */
export function AccountPanel() {
  const connection = useGitHubConnection();
  const [providers, setProviders] = useState<readonly ProviderStatusV2[] | undefined>(undefined);
  const [providersUnread, setProvidersUnread] = useState(false);
  const [providersReloadKey, setProvidersReloadKey] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const accountLabelId = useId();
  const providersLabelId = useId();
  /**
   * `'ok'` rather than `void`, so success is distinguishable from failure. `run()` resolves
   * `undefined` both when the call rejected and when a newer call superseded this one, and a
   * `void` action's success resolves `undefined` too — which would make "did it work?" unanswerable
   * from the outcome alone.
   */
  const disconnection = useAsyncAction<'ok'>();
  /** The in-flight latch. See the note above for why neither `pending` nor `disabled` is one. */
  const writing = useRef(false);

  useEffect(() => {
    let cancelled = false;
    setProvidersUnread(false);
    setProviders(undefined);
    void getBridge()
      .listProvidersV2()
      .then((next) => {
        if (cancelled) return;
        setProviders(next);
      })
      .catch(() => {
        if (cancelled) return;
        // The same rule as the connected-repos list: a failed read reports as unread, never as an
        // empty list. "No providers detected" beside a panel that cannot run anything without one
        // is a worse answer than "we could not check".
        setProvidersUnread(true);
      });
    return () => {
      cancelled = true;
    };
  }, [providersReloadKey]);

  const { run, reset } = disconnection;
  const disconnect = useCallback(() => {
    if (writing.current) return;
    writing.current = true;
    void run(async () => {
      try {
        await getBridge().disconnectGitHub();
        return 'ok' as const;
      } finally {
        // Cleared in `finally` rather than on each branch, because the failure path matters as much
        // as the success one here: a rejected disconnect that left the latch set would make the
        // button permanently inert, with no way back except leaving the screen and returning.
        writing.current = false;
      }
    }).then((outcome) => {
      // Only a real success closes the dialog; a failure leaves it open with the error in it, which
      // is the one moment the user most needs the control still in front of them. Nothing is read
      // from the reply -- `main.ts` says its own answer still describes the daemon on its way out,
      // and `useGitHubConnection` re-reads on the next `daemon:status` `ready`, which is when the
      // new daemon's credential actually takes effect.
      if (outcome === 'ok') setConfirming(false);
    });
  }, [run]);

  const closeConfirm = useCallback(() => {
    setConfirming(false);
    reset();
  }, [reset]);

  const rows = providers === undefined ? undefined : providerRows(providers);
  const chip = connection === undefined ? undefined : connectionChip(connection.state);
  /**
   * The daemon is running on the development fallback (a file under Electron's own data
   * directory, `dev-token-file.ts` -- an inherited shell variable before issue #212), which changes
   * what a disconnect *does* and not just what it says. Before issue #210, clearing the vault
   * restarted the daemon straight back onto that same fallback token -- main now also suppresses
   * it (for the rest of this run) as part of the same click, so "this stops" is the honest
   * sentence, not "this comes back". It still never revokes the token on GitHub itself. Reachable
   * with `state: 'connected'` too: a daemon spawned before the vault was written is on the
   * development fallback while the vault holds a record.
   */
  const inheritedToken = connection !== undefined && isRunningOnInheritedToken(connection);

  return (
    <div className="form-panel">
      {/* `role="group"` so the heading actually names the credential rows for a screen reader,
          rather than the `id` being generated and referenced by nothing. */}
      <div className="fieldset" role="group" aria-labelledby={accountLabelId}>
        <span className="f-lbl" id={accountLabelId}>
          Account
        </span>

        {connection === undefined || chip === undefined ? (
          <LoadLine>Reading this machine&apos;s GitHub credential…</LoadLine>
        ) : (
          <>
            <div className="ident">
              <span className="avatar" aria-hidden="true">
                {connection.login !== undefined ? accountMonogram(connection.login) : '??'}
              </span>
              <span className="ident-text">
                <span className="ident-name">{connection.login ?? 'No account connected'}</span>
                <span className="ident-sub">{signedInLine(connection)}</span>
              </span>
              <span className={chip.className}>{chip.label}</span>
            </div>

            {connection.state === 'unavailable' && (
              <Notice tone="warn" icon="warning" title="No usable credential store here">
                {unavailableReasonLabel(connection.reason)}
              </Notice>
            )}

            {isRunningOnInheritedToken(connection) && (
              <Notice
                tone="warn"
                icon="warning"
                title="This daemon is running on the development fallback"
              >
                Pipenzo is acting with a token read from a local file, not with the account shown
                above. That fallback exists only in a development build whose vault is empty.
                Disconnecting now stops it too, for the rest of this run — it comes back only if
                you restart Pipenzo with the file still in place.
              </Notice>
            )}

            <div className="fieldset">
              <div className="f-row">
                <span className="set-sub">OAuth scope</span>
                <span className="acct-v">{REQUESTED_OAUTH_SCOPE}</span>
              </div>
              <div className="f-row">
                <span className="set-sub">Token location</span>
                <span className="acct-v">{tokenLocationLabel(connection.source)}</span>
              </div>
              <div className="f-row">
                <span className="set-sub">gh CLI</span>
                <span className="acct-v">not used</span>
              </div>
            </div>

            <span className="f-help">
              The <span className="mono">repo</span> scope is what creating labels and opening pull
              requests need, and no narrower scope grants one without the other. Electron main holds
              the token and hands it to Pipenzo&apos;s own daemon over a pipe rather than through its
              environment, so it is never sitting in a variable a subprocess could print. No provider
              subprocess receives it, and it never reaches this window. Pipenzo also never invokes
              the <span className="mono">gh</span> binary, so nothing on your{' '}
              <span className="mono">PATH</span> is part of the publish path.
            </span>
          </>
        )}
      </div>

      <div className="fieldset">
        <span className="f-lbl" id={providersLabelId}>
          Providers <span className="self-tag">brought by you, not by Pipenzo</span>
        </span>

        {providersUnread ? (
          // A retry, because the reason this fails is one that stops being true: the daemon rejects
          // the call while it is still starting, and the disconnect on this very panel restarts it.
          // Naming a transient cause and then offering no way to re-ask leaves the only exit as
          // navigating off Settings and back.
          <Notice
            tone="warn"
            icon="warning"
            title="Could not check your providers"
            actions={[
              {
                label: 'Try again',
                onClick: () => setProvidersReloadKey((key) => key + 1),
              },
            ]}
          >
            The daemon rejects this while it is still starting. This says nothing about your
            provider sign-ins — the panel simply could not read them.
          </Notice>
        ) : rows === undefined ? (
          <LoadLine>Checking which agent CLIs are signed in…</LoadLine>
        ) : rows.length === 0 ? (
          <p className="repo-list-empty">
            No agent CLI was detected on this machine. Pipenzo runs the CLIs you already have; it
            does not ship one.
          </p>
        ) : (
          <ul className="prov-rows" aria-labelledby={providersLabelId}>
            {rows.map((row) => (
              <li className="prov" key={row.id}>
                <span className={row.ok ? 'p-ic' : 'p-ic off'} aria-hidden="true">
                  <Icon name={row.ok ? 'check' : 'minus'} size="xs" />
                </span>
                <span className="grow">{row.name}</span>
                <span className="mono">{row.status}</span>
              </li>
            ))}
          </ul>
        )}

        <span className="f-help">
          Pipenzo never sees or stores these credentials — agentdock&apos;s provider detection does,
          exactly as it does for its own sessions. Two vendors is also what lets the adversarial
          verifier be cross-vendor.
        </span>
      </div>

      {/* Hidden only for `disconnected`, which is the one state that guarantees there is nothing to
          clear: `status()` returns it only after `#readRecord()` has found no file at all.
          `unavailable` does **not** mean empty -- `status()` resolves availability before it looks
          for a record, and `unreadable` is returned only once `existsSync` has already passed, so a
          record is definitely on disk. Gating on `connected` stranded exactly that case: the panel
          would say "a stored record exists but cannot be decrypted" and then offer nothing to
          remove it, on a machine where `store()` refuses so nothing could ever overwrite it either.
          Clearing is the recovery there, not a no-op. */}
      {connection !== undefined && connection.state !== 'disconnected' && (
        <div className="danger-row">
          <span className="set-sub">
            {inheritedToken
              ? 'Clears the token from the vault and stops the daemon from re-arming onto the development fallback for the rest of this run. Worktrees, branches and the ticket store stay on disk.'
              : connection.state === 'unavailable'
                ? 'Removes the stored record this machine cannot read, so you can sign in again from scratch. Worktrees, branches and the ticket store stay on disk.'
                : 'Clears the token from the vault, and the daemon restarts without one. Worktrees, branches and the ticket store stay on disk.'}
          </span>
          {/* No `writing.current` check here, deliberately. While a disconnect is in flight the
              dialog is open over this button -- `.scrim` is `position: fixed; inset: 0` and `Dialog`
              traps Tab -- and the latch is released before `confirming` goes back to false, so there
              is no state in which this handler runs with the latch set. The guard that matters is
              the one in `disconnect`, which is on the control a user can actually reach. */}
          <Button
            variant="danger"
            icon="prohibit"
            onClick={() => {
              // Not load-bearing either: `status` can only be `error` while the dialog is open, and
              // every path that closes it resets or succeeds. Kept because "opening a picker session
              // starts it clean" is the invariant, and the next call site should not have to know
              // which of those paths happens to have run.
              reset();
              setConfirming(true);
            }}
          >
            Disconnect GitHub
          </Button>
        </div>
      )}

      <Dialog
        open={confirming}
        // Refused while the disconnect is on the wire. The daemon is being restarted underneath
        // this window, and a dialog that vanishes mid-restart reads as "it finished".
        onClose={() => {
          if (!disconnection.pending) closeConfirm();
        }}
        title="Disconnect GitHub?"
        subtitle="This clears the stored token and restarts the daemon."
        width={520}
        actions={
          <>
            <Button onClick={closeConfirm} disabled={disconnection.pending}>
              Keep it connected
            </Button>
            <Button variant="danger" pending={disconnection.pending} onClick={disconnect}>
              {disconnection.pending ? 'Disconnecting…' : 'Disconnect GitHub'}
            </Button>
          </>
        }
      >
        <div className="fieldset">
          <p className="set-sub">
            Anything running right now stops without a clean cancel. The daemon is handed its
            credential once, at startup, so forgetting one means restarting it — and that restart
            does not wait for work in flight to wind down.
          </p>
          {inheritedToken && (
            <Notice tone="warn" icon="warning" title="Stops the daemon, not the token">
              This daemon is running on the development-fallback token, read from a local file.
              Disconnecting stops it from using that file for the rest of this run — it comes back
              only if you restart Pipenzo with the file still in place. Either way, the token
              itself stays valid on GitHub until you revoke it there yourself.
            </Notice>
          )}
          <p className="set-sub">
            Your worktrees, branches and ticket store stay exactly where they are, and nothing on
            GitHub changes: labels, branches and pull requests are untouched — a disconnect here
            forgets a token, it does not revoke one. Pipenzo has no client secret and cannot revoke
            it for you; the token stays valid until you delete it yourself under{' '}
            <a href={GITHUB_AUTHORIZED_APPS_URL} target="_blank" rel="noreferrer">
              github.com/settings/applications
            </a>
            . Signing in again is the same device flow as the first time.
          </p>
          {disconnection.status === 'error' && (
            <Notice tone="danger" icon="warning" title="Could not disconnect">
              {disconnection.error ?? 'The request failed.'} The credential is still stored.
            </Notice>
          )}
        </div>
      </Dialog>
    </div>
  );
}

/** The identity sub-line. Split out only to keep the JSX above readable. */
function signedInLine(connection: {
  state: 'connected' | 'disconnected' | 'unavailable';
  storedAt?: string;
}): string {
  if (connection.state === 'unavailable') return 'This machine cannot store a credential';
  if (connection.state === 'disconnected') return 'Nothing is stored on this machine';
  const on = storedOnLabel(connection.storedAt);
  return on !== undefined ? `Signed in via device flow, ${on}` : 'Signed in via device flow';
}
