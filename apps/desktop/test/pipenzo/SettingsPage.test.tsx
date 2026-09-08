import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearBridgeOverride, setBridgeOverride } from '../../src/bridge.js';
import { SettingsPage } from '../../src/pipenzo/SettingsPage.js';

afterEach(() => {
  cleanup();
  clearBridgeOverride();
});

function installBridge() {
  setBridgeOverride({
    pipenzoConnectedRepos: vi.fn().mockResolvedValue({ repositories: ['octocat/hello-world'] }),
    pipenzoListRepos: vi.fn().mockResolvedValue({ repositories: [], truncated: false }),
    pipenzoConnectRepos: vi.fn(),
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

    const columns = container.querySelectorAll('.cols > .col');
    expect(columns).toHaveLength(1);
    expect(columns[0]?.querySelector('.form-panel')).not.toBeNull();
  });

  it('hosts the connected-repos panel', async () => {
    installBridge();
    render(<SettingsPage />);

    expect(await screen.findByText('Connected repos')).toBeInTheDocument();
    expect(await screen.findByText('octocat/hello-world')).toBeInTheDocument();
  });
});
