import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearBridgeOverride, setBridgeOverride } from '../../src/bridge.js';
import { SettingsPage } from '../../src/pipenzo/SettingsPage.js';

afterEach(() => {
  cleanup();
  clearBridgeOverride();
});

/** Every method the panels this page hosts reach for on mount, and nothing else. */
function installBridge() {
  setBridgeOverride({
    pipenzoConnectedRepos: vi.fn().mockResolvedValue({ repositories: ['octocat/hello-world'] }),
    pipenzoListRepos: vi.fn().mockResolvedValue({ repositories: [], truncated: false }),
    pipenzoConnectRepos: vi.fn(),
    pipenzoGitHubConnection: vi
      .fn()
      .mockResolvedValue({ state: 'connected', login: 'octocat', source: 'vault' }),
    getDaemonStatus: vi.fn().mockResolvedValue({ state: 'ready' }),
    onDaemonStatus: () => () => {},
    listProvidersV2: vi.fn().mockResolvedValue([]),
    disconnectGitHub: vi.fn(),
  } as never);
}

describe('SettingsPage', () => {
  it('opens with the per-machine framing note, above everything else', async () => {
    installBridge();
    const { container } = render(<SettingsPage />);
    await screen.findByText('octocat/hello-world');

    const note = container.querySelector('.sec-note');
    expect(note).toHaveTextContent(/Everything here is per-machine/);
    // First child of the page, not merely present: it is context for the panels under it, and a
    // note read after the thing it frames has already done its damage.
    expect(container.querySelector('.page')?.firstElementChild).toBe(note);
  });

  it('lays the panels out in the two-column grid', async () => {
    installBridge();
    const { container } = render(<SettingsPage />);
    await screen.findByText('octocat/hello-world');

    // Both columns are occupied now that #130's Account panel has landed beside #125's repo list.
    // A `.col` element stays absent until something fills it, so this count is the page's own
    // statement about how many panels it hosts, not a layout constant.
    const columns = container.querySelectorAll('.cols > .col');
    expect(columns).toHaveLength(2);
    expect(columns[0]?.querySelector('.form-panel')).not.toBeNull();
    expect(columns[1]?.querySelector('.form-panel')).not.toBeNull();
  });

  it('hosts the connected-repos panel', async () => {
    installBridge();
    render(<SettingsPage />);

    expect(await screen.findByText('Connected repos')).toBeInTheDocument();
    expect(await screen.findByText('octocat/hello-world')).toBeInTheDocument();
  });

  it('hosts the account panel', async () => {
    installBridge();
    render(<SettingsPage />);

    expect(await screen.findByText('Account')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /disconnect github/i })).toBeInTheDocument();
  });
});
