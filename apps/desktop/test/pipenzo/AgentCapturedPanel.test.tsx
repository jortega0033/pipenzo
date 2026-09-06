import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { McpServerListV2, PipenzoCaptureCapabilityV1 } from '@agent-dock/shared';
import {
  AgentCapturedPanel,
  detectSymbolGraphServer,
} from '../../src/pipenzo/AgentCapturedPanel.js';

/**
 * Issue #124, against Models.dc.html's "Agent-captured evidence" fieldset.
 *
 * The panel's claim is that every row reflects a real probe. So the tests are about what it says
 * when a probe answered no, when a probe has not answered yet, and about the one row that has no
 * toggle because Pipenzo does not own the thing behind it.
 */

function capabilities(
  overrides: Partial<PipenzoCaptureCapabilityV1> = {},
): PipenzoCaptureCapabilityV1 {
  return {
    schemaVersion: 1,
    screenshot: { available: true, packageName: 'playwright' },
    escapeHatch: { configured: false, reason: 'this repository configures no pipenzo.verify.screenshot command' },
    activeTrustClass: 'agent-proposed-manifest',
    ...overrides,
  };
}

function panel(props: Partial<Parameters<typeof AgentCapturedPanel>[0]> = {}) {
  return render(
    <AgentCapturedPanel
      capabilities={capabilities()}
      screenshotEnabled
      onScreenshotEnabledChange={() => undefined}
      escapeHatchEnabled={false}
      onEscapeHatchEnabledChange={() => undefined}
      {...props}
    />,
  );
}

describe('AgentCapturedPanel', () => {
  it('labels the zone as one that never satisfies a gate', () => {
    panel();
    expect(screen.getByText('never satisfies a gate')).toBeInTheDocument();
  });

  it('shows what the probe actually detected, naming the package', () => {
    panel();
    expect(screen.getByText('detected — playwright')).toBeInTheDocument();
  });

  /**
   * README: capability-detected, degrading to a *stated* reduced mode rather than an error. The
   * daemon's reason travels to the row, so the panel never has to invent one.
   */
  it('states the daemon’s own reason when Playwright is absent', () => {
    panel({
      capabilities: capabilities({
        screenshot: {
          available: false,
          reason: 'this repository has no Playwright dependency; screenshot verification is off',
        },
        activeTrustClass: null,
      }),
    });
    expect(screen.getByText(/no Playwright dependency/)).toBeInTheDocument();
  });

  /**
   * "We have not looked" and "we looked and found nothing" are different facts, and only the
   * second is a reason to change the repository.
   */
  it('says the probe is still running rather than guessing an answer', () => {
    panel({ capabilities: undefined });
    expect(screen.getAllByText('checking this repository…')).toHaveLength(2);
  });

  /** Unavailable is a fact, not a preference: there is nothing to switch on. */
  it('disables the screenshot toggle when the capability is unavailable', () => {
    panel({
      capabilities: capabilities({
        screenshot: { available: false, reason: 'no Playwright here' },
        activeTrustClass: null,
      }),
      screenshotEnabled: false,
    });
    expect(screen.getByRole('switch', { name: 'Screenshot verification' })).toBeDisabled();
  });

  it('lets a human switch a detected capability off — off is a choice', () => {
    const onChange = vi.fn();
    panel({ onScreenshotEnabledChange: onChange });
    const control = screen.getByRole('switch', { name: 'Screenshot verification' });
    expect(control).not.toBeDisabled();
    fireEvent.click(control);
    expect(onChange).toHaveBeenCalledWith(false);
  });

  /** The escape hatch is a different trust class, and the row says why it is acceptable. */
  it('describes the escape hatch as a different trust class, with the reason', () => {
    panel();
    const row = screen.getByText(/A free-form command for repos without Playwright/);
    expect(row.textContent).toContain('different trust class');
    expect(row.textContent).toContain('repo-authored and human-committed');
    expect(screen.getByRole('switch', { name: 'Screenshot escape hatch' })).toBeDisabled();
  });

  it('enables the escape-hatch toggle once the repository actually configures one', () => {
    panel({
      capabilities: capabilities({
        screenshot: { available: false, reason: 'no Playwright here' },
        escapeHatch: { configured: true },
        activeTrustClass: 'repo-authored-command',
      }),
    });
    expect(screen.getByRole('switch', { name: 'Screenshot escape hatch' })).not.toBeDisabled();
    expect(
      screen.getByText('pipenzo.verify.screenshot configured in this repository'),
    ).toBeInTheDocument();
    // And the panel says which trust class a capture would actually run under right now.
    expect(screen.getByText(/would run through the repo-authored command/)).toBeInTheDocument();
  });

  /**
   * The symbol-graph row has no toggle at all: Pipenzo ships none of its own and adds no MCP UI,
   * and a toggle would imply it owned something it does not.
   */
  it('marks the symbol graph as runtime, with no toggle and the Grep/Glob fallback note', () => {
    panel();
    expect(screen.getAllByRole('switch')).toHaveLength(2);
    expect(screen.getByText('runtime')).toBeInTheDocument();
    expect(
      screen.getByText('not configured — Implement falls back to Grep/Glob'),
    ).toBeInTheDocument();
  });

  it('names the configured symbol-graph server, still read-only', () => {
    panel({ symbolGraph: { configured: true, serverName: 'symbol-graph' } });
    expect(screen.getByText('symbol-graph — read-only, at runtime')).toBeInTheDocument();
    expect(screen.getAllByRole('switch')).toHaveLength(2);
  });
});

describe('detectSymbolGraphServer', () => {
  const list = (servers: Partial<McpServerListV2['servers'][number]>[]): McpServerListV2 =>
    ({
      revision: 'r1',
      servers: servers.map((server) => ({
        id: 'x',
        provider: 'claude',
        name: 'x',
        ownership: 'user',
        scope: 'user',
        transport: 'stdio',
        enabled: true,
        required: false,
        connectionStatus: 'connected',
        authStatus: 'not_required',
        catalog: { tools: 0, resources: 0, prompts: 0 },
        capabilities: { connect: false, reload: false, configure: false, oauth: false, disable: false },
        ...server,
      })),
    }) as unknown as McpServerListV2;

  it('recognises a symbol-graph server the operator configured', () => {
    expect(detectSymbolGraphServer(list([{ id: 'symbol-graph', name: 'Symbol Graph' }]))).toEqual({
      configured: true,
      serverName: 'Symbol Graph',
    });
  });

  it('does not count a configured-but-disabled server as available', () => {
    expect(
      detectSymbolGraphServer(list([{ id: 'symbol-graph', name: 'Symbol Graph', enabled: false }])),
    ).toEqual({ configured: false });
  });

  it('reports not-configured for an unrelated server list, and for no list at all', () => {
    expect(detectSymbolGraphServer(list([{ id: 'github', name: 'GitHub' }]))).toEqual({
      configured: false,
    });
    expect(detectSymbolGraphServer(undefined)).toEqual({ configured: false });
  });
});
