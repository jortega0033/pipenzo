import { useCallback, useEffect, useRef, useState } from 'react';
import type { PipenzoCaptureCapabilityV1, PipenzoCaptureSettingsV1 } from '@agent-dock/shared';
import { getBridge } from '../bridge.js';
import { Banner } from '../components/primitives/Banner.js';
import { Button } from '../components/primitives/Button.js';
import { LoadLine } from '../components/primitives/LoadLine.js';
import { Notice } from '../components/primitives/Notice.js';
import { AgentCapturedPanel, detectSymbolGraphServer, type SymbolGraphStatus } from './AgentCapturedPanel.js';
import { BOARD_IMPLEMENT_PROVIDER } from './BoardImplementDialog.js';
import { DeterministicGatesPanel } from './DeterministicGatesPanel.js';
import { useAsyncAction } from './use-async-action.js';

/**
 * The Models & gates screen (issue #470) -- `Models.dc.html`'s "Deterministic gates" and
 * "Agent-captured evidence" sections, mounted for real: `DeterministicGatesPanel` (#123) and
 * `AgentCapturedPanel` (#124) both rendered real, tested content already, but neither had a route
 * this shell's navigation actually reached. This is that route, following the same "container owns
 * the real data, the panel owns the rendering" split #341 already established for
 * `TicketDetailContainer`/`DiffReviewScreen`.
 *
 * ## What is deliberately not here
 *
 * `Models.dc.html` also draws a "Model routing" section above the two this screen mounts -- a
 * routing-class table with per-class model pickers, deterministic-override and retry-escalation
 * notes, and a "task-type-aware routing" block the canvas itself marks `near-term post-MVP`. None
 * of that has a real settings surface behind it yet (no daemon route reads or writes a routing
 * class's model, and the task-type table is explicitly not-yet-built), so building it here would
 * be exactly the fabricated content this repo's own discipline (CLAUDE.md) rules out. It is its
 * own future ticket, not a gap in this one.
 *
 * ## Why this screen needs a repository at all
 *
 * `DeterministicGatesPanel` needs none -- the five gates are the same non-negotiable set regardless
 * of repository, which is why it takes no props. `AgentCapturedPanel`'s capability line is
 * different: `pipenzoCaptureCapabilities` and the symbol-graph MCP list are both real probes of one
 * checkout, not configuration, so they need a `repositoryPath` to probe. `activeRepo` is the same
 * `owner/name` the sidebar's workspace switcher already tracks (issue #89) -- this screen resolves
 * it to a local checkout with `resolvePipenzoCheckout` (issues #342/#344), the same call
 * `BoardImplementDialog` already makes for a ticket, just without the workspace-trust gate that
 * only an agent-running dialog needs: a capability probe reads the filesystem, it never runs an
 * agent session against the checkout.
 *
 * `BOARD_IMPLEMENT_PROVIDER` is reused, not a new picker, for the symbol-graph MCP list for the
 * same reason `BoardImplementDialog` states for its own use of that constant: nothing in the app
 * lets a person choose a provider per ticket yet, so the provider whose MCP configuration actually
 * matters -- the one Implement will actually dispatch to -- is the one this screen checks.
 *
 * ## The two toggles' persistence (issue #470's own scope)
 *
 * `screenshotEnabled`/`escapeHatchEnabled` had no settings-store write path anywhere in the daemon
 * before this ticket -- `pipenzo-capture-settings-v1.ts`/`PipenzoCaptureSettingsStore`/
 * `registerPipenzoCaptureSettingsRoutes` are the new store, following `PipenzoConcurrencyStore`'s
 * own shape exactly (issue #126). The load/save logic below mirrors `ConcurrencyPanel`'s own: an
 * optimistic update that reverts to the last daemon-confirmed value on a failed save, never a
 * stepper (or here, a toggle) left showing a value nothing on disk agrees with.
 */
export function ModelsGatesScreen({ activeRepo }: { activeRepo?: string }) {
  const checkout = useAsyncAction<string>();
  const { run: runCheckout } = checkout;

  useEffect(() => {
    if (!activeRepo) return;
    void runCheckout(async () => {
      const { repositoryPath } = await getBridge().resolvePipenzoCheckout({ repo: activeRepo });
      return repositoryPath;
    });
  }, [runCheckout, activeRepo]);

  const repositoryPath = checkout.result;

  // The real capability probe (issue #124): undefined while unresolved or in flight, so
  // `AgentCapturedPanel`'s own "checking this repository…" state covers the whole wait rather than
  // this screen guessing an answer early.
  const [capabilities, setCapabilities] = useState<PipenzoCaptureCapabilityV1 | undefined>(
    undefined,
  );
  const [capabilitiesError, setCapabilitiesError] = useState<string | undefined>(undefined);
  const [capabilitiesReloadKey, setCapabilitiesReloadKey] = useState(0);

  useEffect(() => {
    if (!repositoryPath) {
      setCapabilities(undefined);
      setCapabilitiesError(undefined);
      return;
    }
    let cancelled = false;
    setCapabilities(undefined);
    setCapabilitiesError(undefined);
    void getBridge()
      .pipenzoCaptureCapabilities({ repositoryPath })
      .then((result) => {
        if (cancelled) return;
        setCapabilities(result);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setCapabilitiesError(
          error instanceof Error ? error.message : "could not check this repository's capabilities",
        );
      });
    return () => {
      cancelled = true;
    };
  }, [repositoryPath, capabilitiesReloadKey]);

  // The symbol-graph row (issue #124): agentdock's own real MCP server list, resolved against the
  // one provider Implement actually runs on today. A failure here (including `workspace_untrusted`
  // -- this checkout may never have been trusted for an interactive session) degrades to "not
  // configured", the same honest fallback `detectSymbolGraphServer` already answers for an empty
  // list, rather than a third, unmodeled state `AgentCapturedPanel` has no row for.
  const [symbolGraph, setSymbolGraph] = useState<SymbolGraphStatus>({ configured: false });

  useEffect(() => {
    if (!repositoryPath) {
      setSymbolGraph({ configured: false });
      return;
    }
    let cancelled = false;
    void getBridge()
      .listMcpServers(BOARD_IMPLEMENT_PROVIDER, repositoryPath)
      .then((list) => {
        if (cancelled) return;
        setSymbolGraph(detectSymbolGraphServer(list));
      })
      .catch(() => {
        if (cancelled) return;
        setSymbolGraph({ configured: false });
      });
    return () => {
      cancelled = true;
    };
  }, [repositoryPath]);

  // The two toggles' real persistence (issue #470) -- same load/save shape `ConcurrencyPanel`
  // already uses for `PipenzoConcurrencyStore` (issue #126), see this file's own doc comment.
  const [settings, setSettings] = useState<PipenzoCaptureSettingsV1 | undefined>(undefined);
  const [settingsLoadError, setSettingsLoadError] = useState<string | undefined>(undefined);
  const [settingsReloadKey, setSettingsReloadKey] = useState(0);
  const [saveError, setSaveError] = useState<string | undefined>(undefined);
  const savingRef = useRef(false);
  const confirmedRef = useRef<PipenzoCaptureSettingsV1 | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    setSettingsLoadError(undefined);
    setSettings(undefined);
    void getBridge()
      .pipenzoCaptureSettings()
      .then((result) => {
        if (cancelled) return;
        confirmedRef.current = result;
        setSettings(result);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setSettingsLoadError(
          error instanceof Error ? error.message : 'could not read your capture settings',
        );
      });
    return () => {
      cancelled = true;
    };
  }, [settingsReloadKey]);

  const save = useCallback(
    (update: { screenshotEnabled: boolean } | { escapeHatchEnabled: boolean }) => {
      if (savingRef.current) return;
      savingRef.current = true;
      setSaveError(undefined);
      void getBridge()
        .pipenzoUpdateCaptureSettings(update)
        .then((result) => {
          savingRef.current = false;
          // The daemon's own confirmed record, not the optimistic value this call sent -- same
          // reasoning `ConcurrencyPanel.save()` documents.
          confirmedRef.current = result;
          setSettings(result);
        })
        .catch((error: unknown) => {
          savingRef.current = false;
          setSaveError(
            error instanceof Error ? error.message : 'could not save that setting',
          );
          setSettings(confirmedRef.current);
        });
    },
    [],
  );

  // What `AgentCapturedPanel` actually gets for `capabilities`: the real probe when one has
  // answered, or -- only when there is nothing to probe at all (no connected repo, or the checkout
  // itself could not be prepared) -- a locally composed, honestly-worded statement of that real
  // fact, using the schema's own `reason` field exactly the way the daemon's probe does. This is
  // not fabricated data: no capability is claimed either way, and the wording says plainly why.
  const resolvedCapabilities: PipenzoCaptureCapabilityV1 | undefined = !activeRepo
    ? {
        schemaVersion: 1,
        screenshot: { available: false, reason: 'connect a repository in Settings to check this' },
        escapeHatch: { configured: false, reason: 'connect a repository in Settings to check this' },
        activeTrustClass: null,
      }
    : checkout.status === 'error'
      ? {
          schemaVersion: 1,
          screenshot: { available: false, reason: `could not prepare a local checkout: ${checkout.error}` },
          escapeHatch: { configured: false, reason: `could not prepare a local checkout: ${checkout.error}` },
          activeTrustClass: null,
        }
      : capabilitiesError
        ? undefined
        : capabilities;

  return (
    <section className="page">
      <DeterministicGatesPanel />

      {capabilitiesError && (
        <Notice
          tone="danger"
          icon="warning"
          title="Could not check this repository's screenshot capability"
          actions={[{ label: 'Try again', onClick: () => setCapabilitiesReloadKey((key) => key + 1) }]}
        >
          {capabilitiesError}
        </Notice>
      )}

      {settingsLoadError !== undefined ? (
        <Notice
          tone="danger"
          icon="warning"
          title="Could not read your agent-captured evidence settings"
          actions={[{ label: 'Try again', onClick: () => setSettingsReloadKey((key) => key + 1) }]}
        >
          Nothing has been changed.
        </Notice>
      ) : settings === undefined ? (
        <LoadLine>Reading your agent-captured evidence settings…</LoadLine>
      ) : (
        <>
          <AgentCapturedPanel
            capabilities={resolvedCapabilities}
            symbolGraph={symbolGraph}
            screenshotEnabled={settings.screenshotEnabled}
            onScreenshotEnabledChange={(enabled) => {
              setSettings({ ...settings, screenshotEnabled: enabled });
              save({ screenshotEnabled: enabled });
            }}
            escapeHatchEnabled={settings.escapeHatchEnabled}
            onEscapeHatchEnabledChange={(enabled) => {
              setSettings({ ...settings, escapeHatchEnabled: enabled });
              save({ escapeHatchEnabled: enabled });
            }}
          />
          {saveError !== undefined && (
            <Notice tone="danger" icon="warning" title="Could not save that setting">
              {saveError}
            </Notice>
          )}
        </>
      )}

      {activeRepo && checkout.status === 'error' && (
        <Banner
          icon="warning"
          tone="danger"
          action={
            <Button size="sm" variant="ghost" onClick={() => void checkout.retry()}>
              Retry
            </Button>
          }
        >
          Couldn&apos;t prepare a local checkout of <span className="mono">{activeRepo}</span>, so
          the capability line above states that rather than a real detection result.
        </Banner>
      )}
    </section>
  );
}
