import type { McpServerListV2, PipenzoCaptureCapabilityV1 } from '@agent-dock/shared';
import { Fieldset } from '../components/primitives/Fieldset.js';
import { Icon } from '../components/primitives/Icon.js';
import { Toggle } from '../components/primitives/Toggle.js';

/**
 * The Models & gates screen's agent-captured panel (issue #124) — Models.dc.html's
 * "Agent-captured evidence" fieldset.
 *
 * Everything in this panel is real. The screenshot row's capability line comes from
 * `pipenzoCaptureCapabilities`, a daemon-side probe that resolves the repository's Playwright
 * without loading it; the escape-hatch row reads the repository's committed
 * `pipenzo.verify.screenshot`; the symbol-graph row reads agentdock's own MCP server list. None of
 * the three is a setting the panel invents a value for, which matters here more than usual —
 * README requires both optional capabilities "degrade to a stated-out-loud reduced mode rather
 * than an error", and a toggle with a plausible label and no probe behind it is exactly the
 * unstated reduced mode.
 *
 * ## Three rows, three different kinds of thing
 *
 * - **Screenshot verification** is a real toggle: the operator may switch it off even when
 *   Playwright is present. Off is a choice; unavailable is a fact, and the row says which applies.
 * - **The escape hatch** is a different *trust class*, not a lesser version of the row above it.
 *   The label says why it is acceptable — repo-authored and human-committed, so a person has
 *   already reviewed it — because an operator toggling it on is taking that trade and should be
 *   able to read it here rather than in a design document.
 * - **The symbol graph** has no toggle at all. It is inherited from agentdock's runtime like any
 *   other stdio MCP server, and Pipenzo ships none of its own and adds no MCP UI. A toggle here
 *   would imply Pipenzo owned something it does not, so the control column says `runtime` and the
 *   row states the read-only fallback instead.
 *
 * And the fieldset label carries `never satisfies a gate`, which is the whole reason this zone is
 * separate from the deterministic one.
 */

export interface SymbolGraphStatus {
  readonly configured: boolean;
  readonly serverName?: string;
}

/**
 * Finds a symbol-graph MCP server in agentdock's real server list.
 *
 * A name match, and deliberately a loose one: Pipenzo ships no symbol-graph server and defines no
 * registry of them, so the only honest thing it can do is recognise what the operator configured.
 * A stricter match against a list of blessed server ids would be Pipenzo quietly owning a
 * catalogue it does not have.
 */
export function detectSymbolGraphServer(list?: McpServerListV2): SymbolGraphStatus {
  const match = list?.servers.find((server) =>
    /symbol[-\s_]?graph|code[-\s_]?graph/i.test(`${server.id} ${server.name}`),
  );
  if (!match || !match.enabled) return { configured: false };
  return { configured: true, serverName: match.name };
}

function CapabilityLine({ detected, children }: { detected: boolean; children: string }) {
  return (
    <span className={detected ? 'cap on' : 'cap'}>
      <Icon name={detected ? 'check' : 'prohibit'} size="sm" />
      {children}
    </span>
  );
}

export function AgentCapturedPanel({
  capabilities,
  symbolGraph = { configured: false },
  screenshotEnabled,
  onScreenshotEnabledChange,
  escapeHatchEnabled,
  onEscapeHatchEnabledChange,
}: {
  /**
   * The daemon's probe of this repository. Undefined while it is still in flight — the rows then
   * say the probe has not answered rather than guessing an answer, because "we have not looked" and
   * "we looked and found nothing" are different facts and the second one is a reason to change the
   * repository.
   */
  capabilities?: PipenzoCaptureCapabilityV1;
  /** Derived from agentdock's real MCP server list via `detectSymbolGraphServer`. */
  symbolGraph?: SymbolGraphStatus;
  screenshotEnabled: boolean;
  onScreenshotEnabledChange: (enabled: boolean) => void;
  escapeHatchEnabled: boolean;
  onEscapeHatchEnabledChange: (enabled: boolean) => void;
}) {
  const screenshot = capabilities?.screenshot;
  const escapeHatch = capabilities?.escapeHatch;

  return (
    <div className="form-panel agent-captured-panel">
      <Fieldset label="Agent-captured evidence">
        <span className="self-tag">never satisfies a gate</span>

        <div className="gate-row">
          <span className="gate-text">
            <span className="gate-name">Screenshot verification</span>
            <span className="gate-sub">
              The repo’s own Playwright, driven by the daemon from a schema-validated capture
              manifest. No agent-generated JavaScript ever runs inside the process holding the token
              vault.
            </span>
            {screenshot === undefined ? (
              <CapabilityLine detected={false}>checking this repository…</CapabilityLine>
            ) : screenshot.available ? (
              <CapabilityLine detected>{`detected — ${screenshot.packageName ?? 'playwright'}`}</CapabilityLine>
            ) : (
              <CapabilityLine detected={false}>
                {screenshot.reason ?? 'not available in this repository'}
              </CapabilityLine>
            )}
          </span>
          <span className="gate-ctl">
            <Toggle
              checked={screenshotEnabled}
              // Unavailable is a fact, not a preference: there is nothing to switch on.
              disabled={screenshot?.available !== true}
              onChange={onScreenshotEnabledChange}
              aria-label="Screenshot verification"
            />
          </span>
        </div>

        <div className="gate-row">
          <span className="gate-text">
            <span className="gate-name">pipenzo.verify.screenshot escape hatch</span>
            <span className="gate-sub">
              A free-form command for repos without Playwright — a different trust class, because it
              is repo-authored and human-committed, so a person has already reviewed it.
            </span>
            {escapeHatch === undefined ? (
              <CapabilityLine detected={false}>checking this repository…</CapabilityLine>
            ) : escapeHatch.configured ? (
              <CapabilityLine detected>
                pipenzo.verify.screenshot configured in this repository
              </CapabilityLine>
            ) : (
              <CapabilityLine detected={false}>
                {escapeHatch.reason ?? 'no pipenzo.verify.screenshot command is configured'}
              </CapabilityLine>
            )}
          </span>
          <span className="gate-ctl">
            <Toggle
              checked={escapeHatchEnabled}
              disabled={escapeHatch?.configured !== true}
              onChange={onEscapeHatchEnabledChange}
              aria-label="Screenshot escape hatch"
            />
          </span>
        </div>

        <div className="gate-row">
          <span className="gate-text">
            <span className="gate-name">Symbol-graph MCP server</span>
            <span className="gate-sub">
              Inherited from agentdock’s runtime like any other stdio server. Pipenzo ships none of
              its own and adds no MCP UI.
            </span>
            {symbolGraph.configured ? (
              <CapabilityLine detected>
                {`${symbolGraph.serverName ?? 'configured'} — read-only, at runtime`}
              </CapabilityLine>
            ) : (
              <CapabilityLine detected={false}>
                not configured — Implement falls back to Grep/Glob
              </CapabilityLine>
            )}
          </span>
          {/* No toggle. Pipenzo does not own this server and must not imply that it does. */}
          <span className="gate-ctl">
            <span className="gate-lock">runtime</span>
          </span>
        </div>
      </Fieldset>

      <span className="f-help">
        Shown in its own zone in the diff view, carrying a fixed provenance line, and never merged
        into the machine-verified list.
        {capabilities?.activeTrustClass === 'repo-authored-command' && (
          <>
            {' '}
            A capture here would run through the repo-authored command, not the agent-proposed
            manifest — a different trust class, recorded on every screenshot it produces.
          </>
        )}
      </span>
    </div>
  );
}
