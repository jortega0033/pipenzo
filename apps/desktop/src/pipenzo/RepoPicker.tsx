import { useCallback, useEffect, useMemo, useState } from 'react';
import type { PipenzoRepoV1 } from '@agent-dock/shared';
import { getBridge } from '../bridge.js';
import { Button } from '../components/primitives/Button.js';
import { Empty } from '../components/primitives/Empty.js';
import { Icon } from '../components/primitives/Icon.js';
import { LoadLine } from '../components/primitives/LoadLine.js';
import { Notice } from '../components/primitives/Notice.js';
import {
  connectCtaLabel,
  filterRepos,
  isSelectable,
  relativeTime,
  repoMonogram,
  selectableSelection,
  selectionSummary,
} from './repo-picker.js';

/**
 * The repository picker (issue #115): a searchable, multi-select list of everything this credential
 * can write to, whose CTA writes the workspace's connected-repos list.
 *
 * Standalone rather than folded into `ConnectScreen`, because #125 reuses it: Settings' "Add a
 * repo…" is this same component with a different frame around it. So it owns its own loading,
 * empty and error states, takes its selection from what is already connected, and reports back
 * rather than deciding what happens next.
 *
 * The canvas specifies none of those three states — it draws only the populated list — so they are
 * designed here. The shape they are designed to is the one the rest of this flow uses: say what
 * happened, then say whose move it is.
 */
export function RepoPicker({
  onConnected,
  ctaLabel,
}: {
  /** Called with the saved list after a successful write. */
  onConnected?: (repositories: readonly string[]) => void;
  /** Overrides the CTA text. #125's Settings framing says "Save", not "Connect N repos". */
  ctaLabel?: (count: number) => string;
}) {
  const [repositories, setRepositories] = useState<readonly PipenzoRepoV1[] | undefined>(undefined);
  const [truncated, setTruncated] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [query, setQuery] = useState('');
  const [loadError, setLoadError] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | undefined>(undefined);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoadError(undefined);
    setRepositories(undefined);
    // Both reads together: the picker is meaningless without knowing what is *already* connected,
    // and loading them separately would render an unchecked list for a frame and then check boxes
    // under the user's cursor.
    void Promise.all([getBridge().pipenzoListRepos(), getBridge().pipenzoConnectedRepos()])
      .then(([listing, connected]) => {
        if (cancelled) return;
        setRepositories(listing.repositories);
        setTruncated(listing.truncated);
        setSelected(new Set(connected.repositories));
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        // The daemon is the one that talks to GitHub, so its failures arrive here as opaque
        // rejections. Reported as "could not load", never guessed at as a permissions problem.
        setLoadError(error instanceof Error ? error.message : 'could not load your repositories');
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const visible = useMemo(() => filterRepos(repositories ?? [], query), [repositories, query]);
  const selectedCount = useMemo(
    () => selectableSelection(repositories ?? [], selected).length,
    [repositories, selected],
  );

  const toggle = useCallback((repo: PipenzoRepoV1) => {
    if (!isSelectable(repo)) return;
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(repo.fullName)) next.delete(repo.fullName);
      else next.add(repo.fullName);
      return next;
    });
  }, []);

  const submit = useCallback(() => {
    setSaving(true);
    setSaveError(undefined);
    // Re-filtered at submit, not trusted from the click handler: a repository can be archived on
    // GitHub while it sits checked in an open picker, and a refresh would leave it selected.
    const payload = selectableSelection(repositories ?? [], selected);
    void getBridge()
      .pipenzoConnectRepos({ repositories: [...payload] })
      .then((saved) => {
        setSaving(false);
        onConnected?.(saved.repositories);
      })
      .catch((error: unknown) => {
        setSaving(false);
        setSaveError(error instanceof Error ? error.message : 'could not save your selection');
      });
  }, [repositories, selected, onConnected]);

  if (loadError !== undefined) {
    return (
      <Notice
        tone="danger"
        icon="warning"
        title="Could not load your repositories"
        actions={[{ label: 'Try again', onClick: () => setReloadKey((key) => key + 1) }]}
      >
        Pipenzo asked GitHub for the repositories this account can write to and did not get an
        answer. Nothing has been changed.
      </Notice>
    );
  }

  if (repositories === undefined) {
    return <LoadLine>Reading the repositories you can write to…</LoadLine>;
  }

  if (repositories.length === 0) {
    return (
      <Empty icon="board" title="No repositories Pipenzo can manage">
        This account has write access to nothing Pipenzo could open a pull request against.
        Repositories you can only read are deliberately not listed, since Pipenzo could never
        manage one.
      </Empty>
    );
  }

  const label = (ctaLabel ?? connectCtaLabel)(selectedCount);

  return (
    <>
      <div className="pick-search">
        <Icon name="search" />
        <input
          className="field"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          // The count is in the placeholder because the canvas puts it there, and it doubles as the
          // answer to "did it find everything?" before the user has typed anything.
          placeholder={`Filter ${repositories.length} accessible repositories…`}
          aria-label="Filter repositories"
        />
      </div>

      {visible.length === 0 ? (
        <Empty variant="lane" title="No repository matches that filter">
          The filter matches the whole owner/name, so a partial owner works too.
        </Empty>
      ) : (
        <div className="picker" role="group" aria-label="Repositories">
          {visible.map((repo) => (
            <RepoRow
              key={repo.fullName}
              repo={repo}
              checked={selected.has(repo.fullName)}
              onToggle={toggle}
            />
          ))}
        </div>
      )}

      <div className="sel-bar">
        <span className="sel-count">
          <b>{selectionSummary(selectedCount)}</b> · {repositories.length} accessible
        </span>
        <Button
          variant="primary"
          size="lg"
          icon="check"
          pending={saving}
          // Zero is a real selection to *save* in Settings (#125 removes the last repo that way),
          // but it is not a way to finish first-run, so the caller decides by relabelling rather
          // than this component guessing. What it will not do is submit while a save is in flight.
          disabled={saving || selectedCount === 0}
          onClick={submit}
        >
          {saving ? 'Saving…' : label}
        </Button>
      </div>

      {saveError !== undefined && (
        <Notice tone="danger" icon="warning" title="Could not save your selection">
          {saveError} Your choices are still on screen — try again.
        </Notice>
      )}

      {truncated && (
        <Notice tone="warn" icon="warning" title="This list is not complete">
          This account can reach more repositories than Pipenzo lists in one pass, so the ones you
          are looking for may not be here. The most recently pushed are listed first.
        </Notice>
      )}

      <Notice
        quiet
        icon="info"
        title="This list, and only this list, is what the polling reconciler iterates over"
      >
        Selecting a repo adds it to the workspace-level connected-repos list the sidebar&apos;s
        workspace switcher and its &quot;N repos connected&quot; line read from. Repos can be added
        or removed later from this same picker, reachable from the switcher and from Settings.
      </Notice>
    </>
  );
}

/**
 * One row: `.ws-menu-item`, the same row the workspace switcher uses, with the check moved to the
 * leading edge — the canvas's own note says why, and it is a good reason: here the rows are being
 * *chosen*, not switched to.
 *
 * A `<button>` rather than the canvas's `<div tabindex="0">`. The canvas is a static preview and
 * its rows are not really interactive; the existing `.ws-menu-item` in this codebase is already a
 * button, and a div with a tabindex and a click handler is a control that a screen reader announces
 * as nothing in particular.
 */
function RepoRow({
  repo,
  checked,
  onToggle,
}: {
  repo: PipenzoRepoV1;
  checked: boolean;
  onToggle: (repo: PipenzoRepoV1) => void;
}) {
  const selectable = isSelectable(repo);
  const classes = ['ws-menu-item'];
  if (!selectable) classes.push('off');
  else if (checked) classes.push('on');

  return (
    <button
      type="button"
      className={classes.join(' ')}
      // `aria-checked` with `role="checkbox"` rather than a nested input: the whole row is the hit
      // target, and a checkbox inside a button would be two controls where the user sees one.
      role="checkbox"
      aria-checked={selectable ? checked : false}
      // The canvas leaves an archived row focusable and inert, which announces as an ordinary
      // control that silently does nothing. `aria-disabled` says so instead -- and it is not
      // `disabled`, because a disabled button is skipped by a screen reader's control list
      // entirely, and "this repository exists and cannot be chosen" is the thing the row is for.
      aria-disabled={selectable ? undefined : true}
      onClick={() => onToggle(repo)}
    >
      <span className="check">
        <span className={checked && selectable ? 'box on' : 'box'}>
          {checked && selectable && <Icon name="check" size="sm" />}
        </span>
      </span>
      <span className="ws-ic" aria-hidden="true">
        {repoMonogram(repo.fullName)}
      </span>
      <span className="wm-text">
        <span className="wm-name">{repo.fullName}</span>
        <span className="wm-sub">
          {selectable
            ? [
                repo.defaultBranch,
                repo.language,
                `${repo.openIssues} open ${repo.openIssues === 1 ? 'issue' : 'issues'}`,
              ]
                .filter(Boolean)
                .join(' · ')
            : 'archived on GitHub — no PR can be opened against it'}
        </span>
      </span>
      <span className="pick-note">
        {selectable ? (repo.pushedAt ? `updated ${relativeTime(repo.pushedAt)}` : '') : 'read-only'}
      </span>
    </button>
  );
}
