import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  McpServerListV2,
  PipenzoCaptureCapabilityV1,
  PipenzoCaptureSettingsV1,
} from '@agent-dock/shared';
import { clearBridgeOverride, setBridgeOverride } from '../../src/bridge.js';
import { ModelsGatesScreen } from '../../src/pipenzo/ModelsGatesScreen.js';

const REPO = 'jortega0033/pipenzo';
const CHECKOUT = 'D:/pipenzo-state/repos/jortega0033/pipenzo';

function captureSettings(
  overrides: Partial<PipenzoCaptureSettingsV1> = {},
): PipenzoCaptureSettingsV1 {
  return { schemaVersion: 1, screenshotEnabled: true, escapeHatchEnabled: false, ...overrides };
}

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

function installBridge(
  options: {
    settings?: PipenzoCaptureSettingsV1;
    settingsRejects?: boolean;
    updateCaptureSettings?: ReturnType<typeof vi.fn>;
    resolvePipenzoCheckout?: ReturnType<typeof vi.fn>;
    pipenzoCaptureCapabilities?: ReturnType<typeof vi.fn>;
    listMcpServers?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const pipenzoUpdateCaptureSettings =
    options.updateCaptureSettings ??
    vi.fn(async (input: Partial<PipenzoCaptureSettingsV1>) => ({
      ...(options.settings ?? captureSettings()),
      ...input,
    }));
  const bridge = {
    pipenzoCaptureSettings: options.settingsRejects
      ? vi.fn().mockRejectedValue(new Error('daemon is not ready yet'))
      : vi.fn().mockResolvedValue(options.settings ?? captureSettings()),
    pipenzoUpdateCaptureSettings,
    resolvePipenzoCheckout:
      options.resolvePipenzoCheckout ??
      vi.fn().mockResolvedValue({ repo: { owner: 'jortega0033', name: 'pipenzo' }, repositoryPath: CHECKOUT }),
    pipenzoCaptureCapabilities:
      options.pipenzoCaptureCapabilities ?? vi.fn().mockResolvedValue(capabilities()),
    listMcpServers:
      options.listMcpServers ?? vi.fn().mockResolvedValue({ servers: [], revision: 'r1' } satisfies McpServerListV2),
  };
  setBridgeOverride(bridge as never);
  return bridge;
}

afterEach(() => {
  cleanup();
  clearBridgeOverride();
});

const gatesHeading = () =>
  screen.findByText('Deterministic gates — the hard, non-negotiable set');
const agentCapturedLoaded = () => screen.findByText('Screenshot verification');

describe('ModelsGatesScreen', () => {
  it('always mounts the non-negotiable deterministic gates, regardless of repo state', async () => {
    installBridge();
    render(<ModelsGatesScreen activeRepo={REPO} />);
    await gatesHeading();
    expect(screen.getByText('Build, typecheck and lint')).toBeInTheDocument();
    expect(screen.getAllByText('always on')).toHaveLength(5);
  });

  it('resolves the active repo to a local checkout and probes it for real capability data', async () => {
    const bridge = installBridge();
    render(<ModelsGatesScreen activeRepo={REPO} />);
    await agentCapturedLoaded();

    expect(bridge.resolvePipenzoCheckout).toHaveBeenCalledWith({ repo: REPO });
    await waitFor(() =>
      expect(bridge.pipenzoCaptureCapabilities).toHaveBeenCalledWith({ repositoryPath: CHECKOUT }),
    );
    expect(await screen.findByText('detected — playwright')).toBeInTheDocument();
  });

  it('checks the symbol-graph MCP list for the checkout and reflects a configured server', async () => {
    const bridge = installBridge({
      listMcpServers: vi.fn().mockResolvedValue({
        servers: [
          {
            id: 'symbol-graph',
            name: 'symbol-graph-mcp',
            enabled: true,
            transport: 'stdio',
            configFields: [],
          },
        ],
        revision: 'r2',
      } as unknown as McpServerListV2),
    });
    render(<ModelsGatesScreen activeRepo={REPO} />);
    await agentCapturedLoaded();

    await waitFor(() => expect(bridge.listMcpServers).toHaveBeenCalledWith('claude', CHECKOUT));
    expect(await screen.findByText(/symbol-graph-mcp — read-only, at runtime/)).toBeInTheDocument();
  });

  it('states plainly that nothing can be checked when no repository is connected, rather than a perpetual "checking" line', async () => {
    installBridge();
    render(<ModelsGatesScreen />);
    await agentCapturedLoaded();

    expect(
      await screen.findAllByText('connect a repository in Settings to check this'),
    ).toHaveLength(2);
  });

  it('states the checkout failure in the capability line and offers a retry, rather than leaving it "checking" forever', async () => {
    const resolvePipenzoCheckout = vi.fn().mockRejectedValue(new Error('clone failed'));
    const bridge = installBridge({ resolvePipenzoCheckout });
    render(<ModelsGatesScreen activeRepo={REPO} />);
    await agentCapturedLoaded();

    // Both rows share the same real fact -- no checkout, nothing to probe -- so the same wording
    // appears twice (screenshot row and escape-hatch row).
    expect(
      await screen.findAllByText(/could not prepare a local checkout: clone failed/),
    ).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();

    bridge.resolvePipenzoCheckout.mockResolvedValue({
      repo: { owner: 'jortega0033', name: 'pipenzo' },
      repositoryPath: CHECKOUT,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(bridge.resolvePipenzoCheckout).toHaveBeenCalledTimes(2));
  });

  it('reports a failed settings read as unread, and offers a retry', async () => {
    const bridge = installBridge({ settingsRejects: true });
    render(<ModelsGatesScreen activeRepo={REPO} />);

    expect(await screen.findByText(/could not read your agent-captured evidence settings/i)).toBeVisible();

    bridge.pipenzoCaptureSettings.mockResolvedValue(captureSettings());
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await agentCapturedLoaded();
    expect(bridge.pipenzoCaptureSettings).toHaveBeenCalledTimes(2);
  });

  it('flipping the screenshot toggle saves it through the new capture-settings route', async () => {
    const bridge = installBridge({ settings: captureSettings({ screenshotEnabled: true }) });
    render(<ModelsGatesScreen activeRepo={REPO} />);
    await agentCapturedLoaded();
    // The toggle stays disabled until the real capability probe has answered `available: true` --
    // wait for that before clicking, the same "checking…" -> real-state transition the panel itself
    // renders.
    await screen.findByText('detected — playwright');

    fireEvent.click(screen.getByRole('switch', { name: 'Screenshot verification' }));

    await waitFor(() =>
      expect(bridge.pipenzoUpdateCaptureSettings).toHaveBeenCalledWith({ screenshotEnabled: false }),
    );
  });

  it('flipping the escape-hatch toggle saves it independently of the screenshot toggle', async () => {
    const bridge = installBridge({
      settings: captureSettings({ escapeHatchEnabled: false }),
      pipenzoCaptureCapabilities: vi.fn().mockResolvedValue(
        capabilities({ escapeHatch: { configured: true } }),
      ),
    });
    render(<ModelsGatesScreen activeRepo={REPO} />);
    await agentCapturedLoaded();
    // Same reasoning as the screenshot toggle test above: wait for the real probe to answer
    // `configured: true` before the escape-hatch toggle is interactive.
    await screen.findByText('pipenzo.verify.screenshot configured in this repository');

    fireEvent.click(screen.getByRole('switch', { name: 'Screenshot escape hatch' }));

    await waitFor(() =>
      expect(bridge.pipenzoUpdateCaptureSettings).toHaveBeenCalledWith({ escapeHatchEnabled: true }),
    );
  });

  it('reverts the toggle and reports the failure when a save is refused', async () => {
    const updateCaptureSettings = vi.fn().mockRejectedValue(new Error('could not reach the daemon'));
    installBridge({
      settings: captureSettings({ screenshotEnabled: true }),
      updateCaptureSettings,
    });
    render(<ModelsGatesScreen activeRepo={REPO} />);
    await agentCapturedLoaded();
    await screen.findByText('detected — playwright');

    fireEvent.click(screen.getByRole('switch', { name: 'Screenshot verification' }));

    expect(await screen.findByText(/could not save that setting/i)).toBeVisible();
    // Reverted to the last confirmed value -- the toggle's own checked state.
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: 'Screenshot verification' })).toHaveClass('on'),
    );
  });
});
