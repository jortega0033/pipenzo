import type { OwnedWorktreeV2 } from '@agent-dock/shared';
import { getBridge } from '../bridge.js';
import { Button } from '../components/primitives/Button.js';
import { Dialog } from '../components/primitives/Dialog.js';
import { useAsyncAction } from './use-async-action.js';

export interface ImplementDialogTicket {
  readonly num: number;
  readonly title: string;
  /** `owner/name`, shown in the mono subtitle line. */
  readonly repo: string;
  /** e.g. `"+38 −6 · 2 files"` — the Refine estimate label from Main.dc.html's board card. */
  readonly estimateLabel?: string;
}

/**
 * The Implement dialog's Start flow (issue #69's pending-button wiring, extended with the ticket's
 * remaining fields by issue #83). Matches Main.dc.html's `#dialogOpen` dialog.
 *
 * Start's pending state spans two real daemon round trips chained under one `useAsyncAction`,
 * exactly the "holds pending until the daemon has confirmed X" shape the ticket calls for: a
 * worktree preview (so a `.worktreeinclude` that would copy a secret-shaped file into the agent's
 * worktree refuses closed, matching `ImplementOrchestrator`'s own `worktree_secret_risk` gate in
 * `apps/daemon/src/implement-orchestrator.ts`) and then the worktree create itself. Both are real,
 * already-routed daemon calls (`POST /v2/worktrees/preview`, `POST /v2/worktrees`).
 *
 * What this deliberately does NOT do: dispatch the actual implement session inside the new
 * worktree, or run the "assign issue + uncached GET /issues/:n, refuse if claimed elsewhere"
 * pre-flight issue #83 also names. Both require `apps/daemon/src/implement-orchestrator.ts` and a
 * GitHub issue-read/assign call respectively, and neither has an HTTP route yet -- see
 * `ownedLocation()`'s comment in `worktree-manager.ts` for why a worktree's real filesystem path
 * (needed to point a session's `cwd` at it) is deliberately withheld from every route response the
 * renderer can reach. `onStarted` hands the caller the created worktree so it can be wired into
 * that orchestration once the route exists; wiring a session into it here would mean either
 * guessing a path the daemon has never told this process, or silently starting the session
 * somewhere other than the reserved worktree -- both worse than leaving the seam visible.
 */
export function ImplementDialog({
  open,
  onClose,
  ticket,
  cwd,
  onStarted,
}: {
  open: boolean;
  onClose: () => void;
  ticket: ImplementDialogTicket;
  /** The repository checkout the worktree is cut from. */
  cwd: string;
  onStarted?: (worktree: OwnedWorktreeV2) => void;
}) {
  const start = useAsyncAction<OwnedWorktreeV2>();

  const runStart = () =>
    void start
      .run(async () => {
        const name = `issue-${ticket.num}`;
        const preview = await getBridge().previewWorktree({ cwd, name });
        if (preview.secretRisk) {
          throw new Error(
            "This repository's .worktreeinclude would copy a secret-shaped file into the agent " +
              'worktree. Review it in Settings before starting.',
          );
        }
        return getBridge().createWorktree({ cwd, name, confirmIncludeCopy: true });
      })
      .then((worktree) => {
        if (worktree) onStarted?.(worktree);
      });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Implement #${ticket.num} — ${ticket.title}`}
      subtitle={
        <span className="mono">
          {ticket.repo} · pipenzo:queued{ticket.estimateLabel ? ` · est. ${ticket.estimateLabel}` : ''}
        </span>
      }
      width={480}
      actions={
        <>
          <Button onClick={onClose} disabled={start.pending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            icon="play"
            pending={start.pending}
            onClick={start.status === 'error' ? () => void start.retry() : runStart}
          >
            {start.pending ? 'Starting…' : start.status === 'error' ? 'Retry' : 'Start'}
          </Button>
        </>
      }
    >
      {start.status === 'error' && start.error && (
        <span className="f-err" role="alert">
          {start.error}
        </span>
      )}
    </Dialog>
  );
}
