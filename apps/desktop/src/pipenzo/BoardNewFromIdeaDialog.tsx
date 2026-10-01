import { useEffect, useState } from 'react';
import type { WorkspaceTrustViewV2 } from '@agent-dock/shared';
import { getBridge } from '../bridge.js';
import { Button } from '../components/primitives/Button.js';
import { Dialog } from '../components/primitives/Dialog.js';
import { Notice } from '../components/primitives/Notice.js';
import { BOARD_IMPLEMENT_PROVIDER } from './BoardImplementDialog.js';
import { NewFromIdeaDialog } from './NewFromIdeaDialog.js';
import { useAsyncAction } from './use-async-action.js';

interface PreparedCheckout {
  readonly repositoryPath: string;
  readonly trust: WorkspaceTrustViewV2;
}

/**
 * What the command palette's "New from idea" row opens (issue #88's own follow-up): the real
 * `NewFromIdeaDialog`, once there is a real checkout to hand it.
 *
 * `NewFromIdeaDialog` needs a `repositoryPath`, same as `ImplementDialog` needs a `cwd` --
 * and the palette only has the active repo's `owner/name` (the workspace switcher's own pick,
 * issue #89), not a checkout. So this does the same two-step preamble `BoardImplementDialog.tsx`
 * does, for the same reason: `resolvePipenzoCheckout`, then `inspectWorkspace`, gating the real
 * dialog behind an explicit "Trust this checkout" button when the answer is untrusted.
 *
 * The question `BoardCommandPalette.tsx`'s own doc comment left open -- whether drafting needs the
 * same workspace-trust gate Implement does, since a draft is read-only against the repository and
 * only ever writes to GitHub -- resolves to yes, and not by product judgment call: `issue-drafter.ts`
 * *is* an agent session, same shape as Refine, run with `cwd: repositoryPath` and read-only tools.
 * The daemon already refuses to run it in an untrusted workspace (`draftIssue` maps
 * `isWorkspaceUntrustedError` to its own `workspace_untrusted` code) -- so skipping the gate here
 * would not skip the check, it would just mean the first thing a person sees after typing their idea
 * and clicking "Draft issue" is that failure, with no "Trust this checkout" button in sight to fix
 * it. Gating here, before the idea is even typed, is `BoardImplementDialog.tsx`'s own reasoning
 * applied to the same daemon behavior.
 *
 * Trust is never granted here on anyone's behalf, exactly as `BoardImplementDialog.tsx`'s own doc
 * comment insists: an untrusted checkout gets the explicit button and its own explanation, never a
 * silent grant.
 */
export function BoardNewFromIdeaDialog({
  repo,
  onClose,
  onCreated,
}: {
  /** `owner/name` -- the workspace's active repo, the same value the switcher and palette repo
   * rows already carry. */
  repo: string;
  onClose: () => void;
  onCreated?: (issue: { issueNumber: number; htmlUrl: string }) => void;
}) {
  const prepare = useAsyncAction<PreparedCheckout>();
  const trustAction = useAsyncAction<WorkspaceTrustViewV2>();
  const [trustGranted, setTrustGranted] = useState(false);
  const { run: runPrepare } = prepare;

  useEffect(() => {
    void runPrepare(async () => {
      const { repositoryPath } = await getBridge().resolvePipenzoCheckout({ repo });
      const trust = await getBridge().inspectWorkspace(repositoryPath);
      return { repositoryPath, trust };
    });
  }, [runPrepare, repo]);

  const prepared = prepare.result;

  if (prepared && (prepared.trust.state === 'trusted' || trustGranted)) {
    return (
      <NewFromIdeaDialog
        open
        onClose={onClose}
        repositoryPath={prepared.repositoryPath}
        repo={repo}
        provider={BOARD_IMPLEMENT_PROVIDER}
        onCreated={onCreated}
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
      title="New from idea"
      subtitle={<span className="mono">{repo}</span>}
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
          Couldn&apos;t prepare a local checkout of {repo}: {prepare.error}
        </span>
      ) : needsTrust ? (
        <>
          <Notice tone="warn" icon="warning" quiet title="Trust this checkout before drafting">
            Drafting an issue runs an agent session against this checkout, the same way Refine and
            Implement do, which only happens in a workspace you have trusted. Trusting it lets agent
            sessions here use the repository&apos;s own configuration. Nothing has been drafted or
            created.
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
          Preparing a local checkout of <span className="mono">{repo}</span>. The first time,
          Pipenzo clones it into its own managed directory; after that it reuses that checkout.
        </span>
      )}
    </Dialog>
  );
}
