import { useState } from 'react';
import type { PipenzoIssueDraftV1, ProviderId } from '@agent-dock/shared';
import { getBridge } from '../bridge.js';
import { Button } from '../components/primitives/Button.js';
import { Dialog } from '../components/primitives/Dialog.js';
import { Textarea } from '../components/primitives/Textarea.js';
import { renderDraftSummary, renderDraftedIssueBody } from './issue-draft.js';
import { useAsyncAction } from './use-async-action.js';

/**
 * "New from idea" (Pipenzo issue #84) — Main.dc.html's plan dialog.
 *
 * Free text in, a drafted issue preview out, then Create issue or Keep chatting. Two properties
 * carry the whole ticket:
 *
 * **Nothing is created until a human clicks Create issue.** Drafting and filing are two calls to
 * two routes, and the second one is only reachable from a button that appears after a person has
 * read the draft. The dialog's own subtitle says so, and the flow makes it true: a model is never
 * the last thing that happened before a ticket appeared in somebody's repository.
 *
 * **The prose is one field and the rest is data.** The draft arrives as `PipenzoIssueDraftV1` —
 * a title plus EARS acceptance criteria, an out-of-scope list, an estimate and open questions —
 * and the body that gets filed is built by `renderDraftedIssueBody`, a pure function over those
 * fields. So the canvas's claim ("every number below it is rendered from data and never
 * rewritten") holds by construction: there is no field on the draft where model-written markdown
 * could sit, and nothing here would render it if there were.
 *
 * Keep chatting keeps the draft *and* the text. Re-drafting from the same words is the one thing
 * an operator will not want after reading a draft they disagree with — the point of the button is
 * to edit the idea and try again, and throwing away what they typed makes that worse.
 */
export function NewFromIdeaDialog({
  open,
  onClose,
  repositoryPath,
  repo,
  provider,
  model,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  /** The checkout the drafter reads to ground itself. It writes nothing. */
  repositoryPath: string;
  /** `owner/name`. Omitted, the daemon uses its configured repository pin. */
  repo?: string;
  provider: ProviderId;
  model?: string;
  onCreated?: (issue: { issueNumber: number; htmlUrl: string }) => void;
}) {
  const [idea, setIdea] = useState('');
  const [draft, setDraft] = useState<PipenzoIssueDraftV1>();
  const drafting = useAsyncAction<PipenzoIssueDraftV1>();
  const creating = useAsyncAction<{ issueNumber: number; htmlUrl: string }>();

  const runDraft = () => {
    if (!idea.trim()) return;
    void drafting
      .run(async () => {
        const result = await getBridge().draftPipenzoIssue({
          idea: idea.trim(),
          repositoryPath,
          provider,
          ...(model ? { model } : {}),
        });
        return result.draft;
      })
      .then((result) => {
        if (result) setDraft(result);
      });
  };

  const runCreate = () => {
    if (!draft) return;
    void creating
      .run(async () => {
        const created = await getBridge().createPipenzoIssue({
          ...(repo ? { repo } : {}),
          title: draft.title,
          // Rendered from the draft's fields. The model wrote the title; it did not write this.
          body: renderDraftedIssueBody(draft),
        });
        return { issueNumber: created.issueNumber, htmlUrl: created.htmlUrl };
      })
      .then((created) => {
        if (!created) return;
        onCreated?.(created);
        setIdea('');
        setDraft(undefined);
        onClose();
      });
  };

  const busy = drafting.pending || creating.pending;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New from idea"
      subtitle="Describe the problem in your own words. pipenzo drafts a scoped issue and nothing is created until you confirm."
      width={520}
      actions={
        draft ? (
          <>
            {/* Keep chatting is not Cancel: it returns to the idea, with the words still there. */}
            <Button onClick={() => setDraft(undefined)} disabled={busy}>
              Keep chatting
            </Button>
            <Button variant="primary" icon="plus" pending={creating.pending} onClick={runCreate}>
              {creating.pending ? 'Creating…' : 'Create issue'}
            </Button>
          </>
        ) : (
          <>
            <Button onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant="primary"
              icon="idea"
              pending={drafting.pending}
              disabled={!idea.trim()}
              onClick={runDraft}
            >
              {drafting.pending ? 'Drafting…' : 'Draft issue'}
            </Button>
          </>
        )
      }
    >
      <Textarea
        label="What’s the problem?"
        placeholder="e.g. non-devs can't tell why a ticket got stuck in Working"
        rows={3}
        value={idea}
        onChange={(event) => setIdea(event.target.value)}
        disabled={busy}
      />

      {draft && (
        <div className="draft">
          <span className="label">Drafted issue</span>
          <span className="draft-title">{draft.title}</span>
          <span className="draft-body">{renderDraftSummary(draft)}</span>
          <span className="f-help">
            Written by a cheap-tier style pass over prose only. Every number, gate result and check
            below it is rendered from data and never rewritten.
          </span>
        </div>
      )}

      {(drafting.status === 'error' || creating.status === 'error') && (
        <span className="f-err" role="alert">
          {drafting.error ?? creating.error}
        </span>
      )}
    </Dialog>
  );
}
