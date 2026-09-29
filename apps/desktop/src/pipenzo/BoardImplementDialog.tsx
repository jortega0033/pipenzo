import { useEffect, useState } from 'react';
import type {
  PipenzoImplementResultV1,
  PipenzoTicketViewV1,
  ProviderId,
  WorkspaceTrustViewV2,
} from '@agent-dock/shared';
import { getBridge } from '../bridge.js';
import { Button } from '../components/primitives/Button.js';
import { Dialog } from '../components/primitives/Dialog.js';
import { Notice } from '../components/primitives/Notice.js';
import { ImplementDialog } from './ImplementDialog.js';
import { useAsyncAction } from './use-async-action.js';

/**
 * The provider a board-started Refine/Implement runs on.
 *
 * A stated default, not a choice: nothing in the app lets a person pick a provider for a ticket yet
 * (`SettingsPage`/`AccountPanel` only *report* which providers are installed and signed in, and the
 * Models & gates screen that would own a picker has no route behind it). #342 asked for the dialog
 * to be reachable, not for that picker, so this names one value in one place, and `ImplementDialog`
 * reads it out ("Runs on claude, with its default model") so nobody has to guess what ran. No
 * model is named, so the provider CLI's own default model is what runs.
 */
export const BOARD_IMPLEMENT_PROVIDER: ProviderId = 'claude';

interface PreparedCheckout {
  readonly repositoryPath: string;
  readonly trust: WorkspaceTrustViewV2;
}

/**
 * What a click on a Queued card opens (issue #342): the real `ImplementDialog`, once there is a real
 * checkout to hand it.
 *
 * `ImplementDialog` needs a `cwd` -- the checkout Refine reads and Implement cuts its worktree from
 * -- and a board ticket carries only `owner/name`. So before the dialog proper, this does the two
 * things that turn one into the other, each a real daemon round trip, and says so on screen while
 * it does:
 *
 * 1. **Resolve the checkout** (`resolvePipenzoCheckout`, #344). The daemon clones the connected repo
 *    into its managed directory the first time and reuses it after. A first clone can take a while,
 *    which is why this is its own visible step with its own Retry rather than a hidden await inside
 *    Refine.
 * 2. **Check workspace trust** (`inspectWorkspace`). agentdock only cuts worktrees from -- and only
 *    runs interactive sessions in -- a workspace a person has trusted, and a checkout Pipenzo just
 *    cloned has not been. Without this step every board-started ticket would refine fine and then
 *    fail at Start with "Workspace is not trusted". Trust is never granted here on anyone's behalf:
 *    an untrusted checkout gets an explicit "Trust this checkout" button that says what trusting
 *    means, exactly the confirmation `App.tsx`'s own run form has always required before a
 *    session. Gating Refine behind it too is deliberate -- Refine also runs an agent against this
 *    checkout's own configuration.
 *
 * Only then does `ImplementDialog` mount, with that path. From there on nothing here is involved:
 * Refine, the claim pre-flight, the worktree preview and the implement dispatch are all
 * `ImplementDialog`'s own, unchanged.
 */
export function BoardImplementDialog({
  ticket,
  onClose,
  onStarted,
  onFailed,
  provider = BOARD_IMPLEMENT_PROVIDER,
}: {
  ticket: PipenzoTicketViewV1;
  onClose: () => void;
  onStarted?: (started: PipenzoImplementResultV1) => void;
  /** Passed straight through to `ImplementDialog`'s own `onFailed` (issue #77) -- this component
   * mediates reaching that dialog but doesn't add a Start failure surface of its own. */
  onFailed?: (message: string, retry: () => void) => void;
  provider?: ProviderId;
}) {
  const prepare = useAsyncAction<PreparedCheckout>();
  const trustAction = useAsyncAction<WorkspaceTrustViewV2>();
  const [trustGranted, setTrustGranted] = useState(false);
  const { run: runPrepare } = prepare;

  useEffect(() => {
    void runPrepare(async () => {
      const { repositoryPath } = await getBridge().resolvePipenzoCheckout({ repo: ticket.repo });
      const trust = await getBridge().inspectWorkspace(repositoryPath);
      return { repositoryPath, trust };
    });
  }, [runPrepare, ticket.repo]);

  const title = ticket.title ?? `Issue #${ticket.issueNumber}`;
  const prepared = prepare.result;

  if (prepared && (prepared.trust.state === 'trusted' || trustGranted)) {
    return (
      <ImplementDialog
        open
        onClose={onClose}
        ticket={{ num: ticket.issueNumber, title, repo: ticket.repo }}
        cwd={prepared.repositoryPath}
        provider={provider}
        onStarted={(started) => onStarted?.(started)}
        onFailed={onFailed}
      />
    );
  }

  const grantTrust = () => {
    if (!prepared) return;
    void trustAction
      .run(() =>
        getBridge().setWorkspaceTrust(prepared.trust.workspaceId, {
          cwd: prepared.repositoryPath,
          incarnation: prepared.trust.incarnation,
          state: 'trusted',
        }),
      )
      .then((trust) => {
        if (trust?.state === 'trusted') setTrustGranted(true);
      });
  };

  const needsTrust = prepared !== undefined && prepare.status !== 'pending';
  const failed = prepare.status === 'error';

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Implement #${ticket.issueNumber} — ${title}`}
      subtitle={<span className="mono">{ticket.repo} · pipenzo:queued</span>}
      width={480}
      actions={
        <>
          <Button onClick={onClose} disabled={trustAction.pending}>
            Cancel
          </Button>
          {failed ? (
            <Button variant="primary" icon="refresh" onClick={() => void prepare.retry()}>
              Retry
            </Button>
          ) : needsTrust ? (
            <Button variant="primary" icon="check" pending={trustAction.pending} onClick={grantTrust}>
              {trustAction.pending ? 'Trusting…' : 'Trust this checkout'}
            </Button>
          ) : (
            <Button variant="primary" icon="git-branch" pending>
              Preparing checkout…
            </Button>
          )}
        </>
      }
    >
      {failed ? (
        <span className="f-err" role="alert">
          Couldn&apos;t prepare a local checkout of {ticket.repo}: {prepare.error}
        </span>
      ) : needsTrust ? (
        <>
          <Notice tone="warn" icon="warning" quiet title="Trust this checkout before starting">
            Refine and Implement run agents against this checkout and cut their worktrees from it,
            which only happens in a workspace you have trusted. Trusting it lets agent sessions here
            use the repository&apos;s own configuration. Nothing has been started.
          </Notice>
          <span className="f-help">
            Checkout: <span className="mono">{prepared.repositoryPath}</span>
          </span>
          {trustAction.status === 'error' && (
            <span className="f-err" role="alert">
              {trustAction.error}
            </span>
          )}
        </>
      ) : (
        <span className="f-help" role="status">
          Preparing a local checkout of <span className="mono">{ticket.repo}</span>. The first time,
          Pipenzo clones it into its own managed directory; after that it reuses that checkout.
        </span>
      )}
    </Dialog>
  );
}
