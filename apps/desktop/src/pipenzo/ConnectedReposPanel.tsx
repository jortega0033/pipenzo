import { useCallback, useEffect, useId, useState } from 'react';
import { getBridge } from '../bridge.js';
import { Dialog } from '../components/primitives/Dialog.js';
import { Icon } from '../components/primitives/Icon.js';
import { IconButton } from '../components/primitives/IconButton.js';
import { LoadLine } from '../components/primitives/LoadLine.js';
import { Notice } from '../components/primitives/Notice.js';
import { RepoPicker } from './RepoPicker.js';
import { repoMonogram, settingsSaveCtaLabel } from './repo-picker.js';

/**
 * Settings' "Connected repos" panel (issue #125): the workspace-level list the polling reconciler
 * iterates over, with a per-row remove and an "Add a repo…" that opens the first-run picker.
 *
 * ## Why this renders the stored list and nothing GitHub knows
 *
 * The canvas draws each row with a live subline — `main · 15 open · 2 running`. None of that is
 * stored, and `pipenzo-repos-v1.ts` is explicit about why: the branch, the language and the issue
 * count are properties of the repository *now*, so keeping a copy would mean serving stale facts
 * out of a file. Fetching them here instead would buy the subline at a price this screen should
 * not pay — one listing call fans out to as many as fifty GitHub requests, and a Settings page that
 * cannot show which repositories are connected until GitHub answers is a Settings page that goes
 * blank exactly when a user opens it to work out why nothing is syncing.
 *
 * So the row is the decision: `owner/name`, which is the entire stored record. The live facts stay
 * where they are already paid for and already relevant — inside the picker behind "Add a repo…",
 * where a user is choosing between repositories rather than reading back a choice.
 *
 * ## Why removal writes the whole list
 *
 * `pipenzoConnectRepos` replaces rather than patches (see `pipenzoConnectReposRequestV1Schema`), so
 * a remove is "the list, minus this one". The list it subtracts from is the one this component
 * loaded, never a filtered view of it — the same rule the picker's save had to be corrected to
 * follow, for the same reason: anything dropped from the payload is deleted from the workspace.
 */
export function ConnectedReposPanel() {
  const [repositories, setRepositories] = useState<readonly string[] | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | undefined>(undefined);
  const [reloadKey, setReloadKey] = useState(0);
  const [removing, setRemoving] = useState<string | undefined>(undefined);
  const [removeError, setRemoveError] = useState<string | undefined>(undefined);
  const [picking, setPicking] = useState(false);
  const labelId = useId();

  useEffect(() => {
    let cancelled = false;
    setLoadError(undefined);
    setRepositories(undefined);
    void getBridge()
      .pipenzoConnectedRepos()
      .then((connected) => {
        if (cancelled) return;
        setRepositories(connected.repositories);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        // The daemon rejects this while it is still starting, which is a real and common state
        // rather than a fault. Either way the honest answer is "we could not read it", never an
        // empty list — an empty list here reads as "you have connected nothing", and the control
        // next to it would then offer to fix a problem the user does not have.
        setLoadError(
          error instanceof Error ? error.message : 'could not read your connected repositories',
        );
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const remove = useCallback(
    (fullName: string) => {
      // Guarded rather than merely disabled: the button is disabled while a removal is in flight,
      // but `repositories` being undefined would make the payload below a guess at the list.
      if (repositories === undefined || removing !== undefined) return;
      const next = repositories.filter((name) => name !== fullName);
      setRemoving(fullName);
      setRemoveError(undefined);
      void getBridge()
        .pipenzoConnectRepos({ repositories: [...next] })
        .then((saved) => {
          setRemoving(undefined);
          // The daemon's own answer, not `next`: it de-duplicates and sorts, and rendering the
          // request instead of the response is how a list on screen starts disagreeing with the
          // file behind it.
          setRepositories(saved.repositories);
        })
        .catch((error: unknown) => {
          setRemoving(undefined);
          // Nothing optimistic was applied, so there is nothing to roll back — the row is still
          // there because it is still connected.
          setRemoveError(error instanceof Error ? error.message : 'could not save the change');
        });
    },
    [repositories, removing],
  );

  return (
    <div className="form-panel">
      <div className="fieldset">
        <span className="f-lbl" id={labelId}>
          Connected repos
        </span>
        <span className="set-sub">
          This list, and only this list, is what the polling reconciler iterates over. It is
          workspace-level, not per-ticket, and it is what the sidebar&apos;s switcher and its
          &quot;N repos connected&quot; line read from.
        </span>

        {loadError !== undefined ? (
          <Notice
            tone="danger"
            icon="warning"
            title="Could not read your connected repositories"
            actions={[{ label: 'Try again', onClick: () => setReloadKey((key) => key + 1) }]}
          >
            Nothing has been changed. Until this loads, adding or removing a repository here would
            be working from a list Pipenzo cannot see.
          </Notice>
        ) : repositories === undefined ? (
          <LoadLine>Reading the repositories this workspace is connected to…</LoadLine>
        ) : (
          <div className="repo-list">
            {repositories.length === 0 ? (
              <p className="repo-list-empty">
                No repositories are connected yet, so nothing is being polled. Choosing one is what
                gives Pipenzo something to watch.
              </p>
            ) : (
              // A real list, so a screen reader announces how many repositories are connected
              // without the user having to arrow through them and count. The "Add a repo…" row
              // below is deliberately outside it: it is an action, not one of the things listed.
              <ul className="repo-rows" aria-labelledby={labelId}>
                {repositories.map((fullName) => (
                  <li className="ws-menu-item" key={fullName}>
                    <span className="ws-ic" aria-hidden="true">
                      {repoMonogram(fullName)}
                    </span>
                    <span className="wm-text">
                      <span className="wm-name">{fullName}</span>
                    </span>
                    <IconButton
                      icon="x"
                      variant="ghost"
                      // Named per row rather than a shared "Remove": an accessible name of
                      // "Remove" repeated once per row is a control list in which every entry is
                      // indistinguishable from the one that would delete something else.
                      aria-label={`Remove ${fullName} from this workspace`}
                      title="Remove from this workspace"
                      disabled={removing !== undefined}
                      onClick={() => remove(fullName)}
                    />
                  </li>
                ))}
              </ul>
            )}
            <button
              type="button"
              className="ws-menu-item foot"
              onClick={() => {
                setRemoveError(undefined);
                setPicking(true);
              }}
            >
              <Icon name="plus" />
              <span className="wm-text">
                <span className="wm-name">Add a repo…</span>
                <span className="wm-sub">opens the same searchable picker as first-run</span>
              </span>
            </button>
          </div>
        )}

        {removeError !== undefined && (
          <Notice tone="danger" icon="warning" title="Could not save that change">
            {removeError} The repository is still connected.
          </Notice>
        )}

        <span className="f-help">
          Removing a repo stops its polls and hides its tickets. It touches nothing on GitHub:
          labels, branches, PRs and the <span className="mono">pipenzo:schema-v1</span> markers all
          stay exactly where they are.
        </span>
      </div>

      {/* The picker, not a second copy of it. It reads the connected list itself on open and
          writes the complete selection on save, which is why "Add a repo…" is also how a repo the
          per-row remove cannot reach — one that is connected and archived — gets unticked. */}
      <Dialog
        open={picking}
        onClose={() => setPicking(false)}
        title="Choose the repos Pipenzo manages"
        subtitle="Everything this credential can open a pull request against. Ticking and unticking here replaces the connected list with exactly what is ticked."
        width={640}
      >
        <RepoPicker
          ctaLabel={settingsSaveCtaLabel}
          onConnected={(saved) => {
            setRepositories(saved);
            setPicking(false);
          }}
        />
      </Dialog>
    </div>
  );
}
