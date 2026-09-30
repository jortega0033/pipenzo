import { useState } from 'react';
import type { PipenzoLessonListV1 } from '@agent-dock/shared';
import { getBridge } from '../bridge.js';
import { Icon } from '../components/primitives/Icon.js';
import { RLink } from '../components/primitives/ApprovalCard.js';
import { countLessonsForRepo } from './lesson-prompt.js';
import { useAsyncAction } from './use-async-action.js';

/**
 * Local, human-gated lesson memory (issue #18): `TicketDetail.dc.html`'s `.lesson` prompt,
 * offered once at a ticket's resolution -- see this component's own callers for what "resolution"
 * means where it is actually wired in today.
 *
 * Two states, matching the canvas's `showLesson`/`showLessonSaved` exactly:
 *
 * - **Offer** (the mount's initial state): an editable one-line field, pre-filled from `prefill`
 *   (`lesson-prompt.ts`'s `deriveLessonPrefill`) but never disabled or read-only -- a person can
 *   clear it, rewrite it, or save it as-is. "Skip" is the ghost button, the lower-emphasis of the
 *   two actions exactly as the canvas draws it, and it does the entire job: nothing is written,
 *   full stop.
 * - **Saved**: rendered only after a real `pipenzoCreateLesson` round trip resolves, with the
 *   daemon's own per-repo count -- never a locally incremented guess -- plus an "Undo" that
 *   actually deletes the just-saved lesson (`pipenzoDeleteLesson`, already wired end-to-end by
 *   issue #128) rather than only resetting local UI state.
 *
 * **Once, not repeating**: `step` only ever moves forward (`offer` -> `hidden` | `saved`); nothing
 * in this component resets it back to `offer` on its own (Undo is the one deliberate exception --
 * a person asking to take the save back, not this component re-arming itself). A fresh
 * resolution is a fresh mount, keyed by whatever identifies that resolution at the call site --
 * this component has no notion of "resolution" of its own to re-key against.
 */
export function LessonPrompt({
  repo,
  issueNumber,
  prefill,
}: {
  /** `owner/name`, matching `pipenzoRepoRefV1Schema`. */
  repo: string;
  issueNumber: number;
  /** `lesson-prompt.ts`'s `deriveLessonPrefill(report)` -- real run data, or `''` when this run
   *  hit nothing notable to draw one from. */
  prefill: string;
}) {
  const [step, setStep] = useState<'offer' | 'hidden' | 'saved'>('offer');
  const [text, setText] = useState(prefill);
  const [savedId, setSavedId] = useState<string>();
  const [repoCount, setRepoCount] = useState(0);
  const save = useAsyncAction<PipenzoLessonListV1>();
  const undo = useAsyncAction<PipenzoLessonListV1>();

  if (step === 'hidden') return null;

  if (step === 'saved') {
    return (
      <div className="lesson">
        <div className="lesson-head">
          <Icon name="check" size="sm" />
          <span className="grow">
            Saved locally — {repoCount} lesson{repoCount === 1 ? '' : 's'} on {repo}
          </span>
          <span className="mono">human-gated</span>
        </div>
        <div className="lesson-foot">
          <span className="lesson-note">
            <Icon name="info" size="sm" />
            <span>
              Handed to the next Refine on this repo as context, never as an instruction, and
              reviewable and deletable in Settings. It is not an index and it never goes stale
              silently — a person wrote it and a person removes it.
            </span>
          </span>
          <span className="run-acts">
            <RLink
              faint
              onClick={() => {
                if (!savedId || undo.pending) return;
                void undo.run(() => getBridge().pipenzoDeleteLesson({ id: savedId })).then((result) => {
                  if (!result) return;
                  setSavedId(undefined);
                  setStep('offer');
                });
              }}
            >
              Undo
            </RLink>
          </span>
        </div>
        {undo.status === 'error' && undo.error && (
          <span className="f-err" role="alert">
            {undo.error}
          </span>
        )}
      </div>
    );
  }

  const trimmed = text.trim();

  return (
    <div className="lesson">
      <div className="lesson-head">
        <Icon name="idea" size="sm" />
        <span className="grow">Worth remembering for next time?</span>
        <span className="mono">optional · you decide</span>
      </div>
      <input
        className="field"
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder="One line, in your words. Drawn from this run's one mispredicted step."
        aria-label="Lesson text"
      />
      <div className="lesson-foot">
        <span className="lesson-note">
          <Icon name="info" size="sm" />
          <span>
            Stays in this repo&apos;s local ticket store. Nothing is written unless you save it,
            and no lesson is ever generated on its own.
          </span>
        </span>
        <span className="run-acts">
          <button className="btn sm ghost" type="button" onClick={() => setStep('hidden')}>
            Skip
          </button>
          <button
            className="btn sm"
            type="button"
            disabled={trimmed.length === 0 || save.pending}
            aria-busy={save.pending || undefined}
            onClick={() =>
              void save
                .run(() => getBridge().pipenzoCreateLesson({ repo, issueNumber, text: trimmed }))
                .then((result) => {
                  if (!result) return;
                  // The store prepends on save (`LessonStore.add()`'s own "newest-saved first"
                  // invariant), so the just-created record is always the list's first entry --
                  // never guessed at by matching text, which two identical lessons could collide on.
                  setSavedId(result.lessons[0]?.id);
                  setRepoCount(countLessonsForRepo(result.lessons, repo));
                  setStep('saved');
                })
            }
          >
            <Icon name="check" size="sm" />
            {save.pending ? 'Saving…' : 'Save lesson'}
          </button>
        </span>
      </div>
      {save.status === 'error' && save.error && (
        <span className="f-err" role="alert">
          {save.error}
        </span>
      )}
    </div>
  );
}
