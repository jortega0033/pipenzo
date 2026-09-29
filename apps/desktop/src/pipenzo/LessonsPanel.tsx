import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { PipenzoLessonV1 } from '@agent-dock/shared';
import { getBridge } from '../bridge.js';
import { IconButton } from '../components/primitives/IconButton.js';
import { LoadLine } from '../components/primitives/LoadLine.js';
import { Notice } from '../components/primitives/Notice.js';
import { lessonMetaLabel } from './lessons.js';

/**
 * Settings' lesson-memory panel (issue #128) — the list-and-delete half of local, human-gated
 * lesson memory (issue #18). `design/artboards/Settings.dc.html`'s own comment on this panel is the
 * acceptance bar: list every saved lesson with its repo/date meta, a per-item delete, and a note
 * that deleting "breaks nothing" because a lesson is not an index.
 *
 * ## What this panel deliberately does not do
 *
 * There is no "add a lesson" control here, and no field to type one into. Saving a lesson happens
 * once, at a ticket's resolution, through `LessonPrompt` (`TicketDetail.dc.html`'s `.lesson` prompt)
 * — that screen is issue #104's own scope, not this one's. This panel only ever *reads* what was
 * saved there and lets a person take one back out; it cannot put one in. That split is what "human-
 * gated" means in practice: nothing on this screen, or anywhere else Pipenzo runs unattended, can
 * create a lesson — only a person, choosing to keep one at the moment a ticket resolved, can.
 *
 * ## Why deleting needs no confirmation dialog, unlike `AccountPanel`'s "Disconnect GitHub"
 *
 * A lesson is a note a person wrote, not a credential or a running process — deleting one costs
 * nothing to redo (save it again next time it turns out to matter) and undoes nothing else running.
 * `design/artboards/Settings.dc.html`'s own copy states the property this panel exists to keep
 * true: a saved lesson "is not an index", so deleting one never reindexes, reorders, or reinterprets
 * any other saved lesson — removing the one row is the entire consequence.
 *
 * ## Why a per-row delete needs no `ConnectedReposPanel`-style `writing` ref
 *
 * `ConnectedReposPanel.remove()` guards against two overlapping writes each building their "next
 * list" from the same pre-removal snapshot — a real race, because that panel sends the *whole* list
 * on every write. Deleting a lesson sends only the one id being removed; the daemon computes the
 * resulting list itself (`LessonStore.remove()`), so two different rows deleted in the same React
 * batch can never race each other into overwriting one another. What *is* guarded, with the same
 * ref-over-state reasoning `ConnectedReposPanel` documents, is a double click on the *same* row
 * landing before `removing` state has committed — harmless on the daemon (a second delete of an
 * already-gone id just 404s), but pointless network traffic and an error banner worth not sending.
 */
export function LessonsPanel() {
  const [lessons, setLessons] = useState<readonly PipenzoLessonV1[] | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | undefined>(undefined);
  const [reloadKey, setReloadKey] = useState(0);
  const [removing, setRemoving] = useState<string | undefined>(undefined);
  const [removeError, setRemoveError] = useState<string | undefined>(undefined);
  const labelId = useId();
  /** The in-flight latch. See the module doc comment for why this guards only a same-row double
   *  click, not a cross-row race the way `ConnectedReposPanel#writing` does. */
  const removingRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    setLoadError(undefined);
    setLessons(undefined);
    void getBridge()
      .pipenzoLessons()
      .then((result) => {
        if (cancelled) return;
        setLessons(result.lessons);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        // The daemon rejects this while it is still starting, matching every other Settings panel's
        // reasoning: the honest answer is "we could not read it", never an empty list, which here
        // would read as "nothing has ever been saved".
        setLoadError(error instanceof Error ? error.message : 'could not read your saved lessons');
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const remove = useCallback((id: string) => {
    if (removingRef.current !== undefined) return;
    removingRef.current = id;
    setRemoving(id);
    setRemoveError(undefined);
    void getBridge()
      .pipenzoDeleteLesson({ id })
      .then((result) => {
        removingRef.current = undefined;
        setRemoving(undefined);
        // The daemon's own answer, not a locally filtered view — same reasoning as
        // `ConnectedReposPanel.remove()`.
        setLessons(result.lessons);
      })
      .catch((error: unknown) => {
        removingRef.current = undefined;
        setRemoving(undefined);
        setRemoveError(error instanceof Error ? error.message : 'could not delete that lesson');
      });
  }, []);

  return (
    <div className="form-panel">
      <div className="fieldset">
        <span className="f-lbl" id={labelId}>
          Lesson memory <span className="self-tag">local · human-gated</span>
        </span>
        <span className="set-sub">
          One-line notes a person chose to save when a ticket resolved. Handed to the next Refine on
          that repo as context, never as an instruction, and never sent to a provider. Nothing is
          ever written here on its own.
        </span>

        {loadError !== undefined ? (
          <Notice
            tone="danger"
            icon="warning"
            title="Could not read your saved lessons"
            actions={[{ label: 'Try again', onClick: () => setReloadKey((key) => key + 1) }]}
          >
            Nothing has been changed. Until this loads, deleting a lesson here would be working from
            a list Pipenzo cannot see.
          </Notice>
        ) : lessons === undefined ? (
          <LoadLine>Reading your saved lessons…</LoadLine>
        ) : lessons.length === 0 ? (
          <p className="repo-list-empty">
            No lessons saved yet. One can be kept the next time a ticket resolves — always offered,
            never automatic.
          </p>
        ) : (
          // A real list, so a screen reader announces how many lessons are saved without arrowing
          // through them and counting.
          <ul className="lesson-list" aria-labelledby={labelId}>
            {lessons.map((lesson) => (
              <li className="lesson-item" key={lesson.id}>
                <span className="li-body">
                  <span className="li-text">{lesson.text}</span>
                  <span className="li-meta">{lessonMetaLabel(lesson)}</span>
                </span>
                <IconButton
                  icon="x"
                  variant="ghost"
                  aria-label={`Delete this lesson: ${lesson.text}`}
                  title="Delete this lesson"
                  disabled={removing !== undefined}
                  onClick={() => remove(lesson.id)}
                />
              </li>
            ))}
          </ul>
        )}

        {removeError !== undefined && (
          <Notice tone="danger" icon="warning" title="Could not delete that lesson">
            {removeError} The lesson is still saved.
          </Notice>
        )}

        <span className="f-help">
          Deleting removes it from that repo&apos;s local ticket store and nothing else changes — it
          is not an index, so there is nothing to reindex and nothing that breaks without it.
        </span>
      </div>
    </div>
  );
}
