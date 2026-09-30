import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearBridgeOverride, setBridgeOverride } from '../../src/bridge.js';
import { SettingsPage } from '../../src/pipenzo/SettingsPage.js';
import { ThemeProvider } from '../../src/theme.js';

afterEach(() => {
  cleanup();
  clearBridgeOverride();
});

// Issue #155: SettingsPage now hosts AppearancePanel, which reads the shared ThemeProvider
// context -- every render here needs one, the same way App-level rendering gets it from
// AppRoot.tsx.
function renderSettingsPage() {
  return render(
    <ThemeProvider>
      <SettingsPage />
    </ThemeProvider>,
  );
}

/** Every method the panels this page hosts reach for on mount, and nothing else. */
function installBridge() {
  setBridgeOverride({
    pipenzoConnectedRepos: vi.fn().mockResolvedValue({ repositories: ['octocat/hello-world'] }),
    pipenzoListRepos: vi.fn().mockResolvedValue({ repositories: [], truncated: false }),
    pipenzoConnectRepos: vi.fn(),
    pipenzoLessons: vi.fn().mockResolvedValue({ lessons: [] }),
    pipenzoCreateLesson: vi.fn(),
    pipenzoDeleteLesson: vi.fn(),
    pipenzoConcurrencySettings: vi
      .fn()
      .mockResolvedValue({ schemaVersion: 1, executionLimit: 2, runBudget: 'unlimited' }),
    pipenzoUpdateConcurrencySettings: vi.fn(),
    pipenzoCaptureSettings: vi
      .fn()
      .mockResolvedValue({ schemaVersion: 1, screenshotEnabled: true, escapeHatchEnabled: false }),
    pipenzoUpdateCaptureSettings: vi.fn(),
    pipenzoListTickets: vi.fn().mockResolvedValue({ tickets: [], workingLaneCapacity: 2 }),
    onPipenzoPhaseEvent: () => () => {},
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
    const { container } = renderSettingsPage();
    await screen.findByText('octocat/hello-world');

    const note = container.querySelector('.sec-note');
    expect(note).toHaveTextContent(/Everything here is per-machine/);
    // First child of the page, not merely present: it is context for the panels under it, and a
    // note read after the thing it frames has already done its damage.
    expect(container.querySelector('.page')?.firstElementChild).toBe(note);
  });

  it('lays the panels out in the two-column grid', async () => {
    installBridge();
    const { container } = renderSettingsPage();
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
    renderSettingsPage();

    expect(await screen.findByText('Connected repos')).toBeInTheDocument();
    expect(await screen.findByText('octocat/hello-world')).toBeInTheDocument();
  });

  it('hosts the account panel', async () => {
    installBridge();
    renderSettingsPage();

    expect(await screen.findByText('Account')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /disconnect github/i })).toBeInTheDocument();
  });

  it('hosts the lesson-memory panel, stacked below connected repos in the same column', async () => {
    installBridge();
    const { container } = renderSettingsPage();
    await screen.findByText('octocat/hello-world');

    expect(await screen.findByText('Lesson memory')).toBeInTheDocument();
    const leftColumn = container.querySelectorAll('.cols > .col')[0];
    const panels = leftColumn?.querySelectorAll('.form-panel');
    expect(panels).toHaveLength(3);
  });

  it('hosts the concurrency panel, between connected repos and lesson memory', async () => {
    installBridge();
    const { container } = renderSettingsPage();
    await screen.findByText('octocat/hello-world');

    expect(await screen.findByText('Concurrency')).toBeInTheDocument();
    const leftColumn = container.querySelectorAll('.cols > .col')[0];
    const panels = leftColumn?.querySelectorAll('.form-panel');
    expect(panels?.[1]?.textContent).toContain('Concurrency');
  });
});
