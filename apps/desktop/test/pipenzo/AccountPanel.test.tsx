import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PipenzoGitHubConnectionV1, ProviderStatusV2 } from '@agent-dock/shared';
import { clearBridgeOverride, setBridgeOverride } from '../../src/bridge.js';
import { AccountPanel } from '../../src/pipenzo/AccountPanel.js';

const CONNECTED: PipenzoGitHubConnectionV1 = {
  state: 'connected',
  login: 'octocat',
  storedAt: '2026-08-12T09:41:00.000Z',
  source: 'vault',
};

const provider = (overrides: Partial<ProviderStatusV2> = {}): ProviderStatusV2 => {
  const id = overrides.id ?? 'claude';
  return {
    name: 'Claude Code CLI',
    installed: true,
    authenticated: 'authenticated',
    transports: [],
    capabilities: [],
    ...overrides,
    id,
    // Irrelevant to every assertion here, but `ProviderStatusV2` requires it and a loose cast
    // would stop the compiler noticing if the shape ever changed under these tests.
    sandbox: {
      providerId: id,
      platform: 'win32',
      provider: { mechanism: 'provider_policy', state: 'unknown', evidence: [] },
      agentDock: { mechanism: 'agentdock_policy', state: 'not_requested', evidence: [] },
      os: { mechanism: 'os_sandbox', state: 'unavailable', evidence: [] },
      badge: 'none',
    },
  };
};

function installBridge(
  options: {
    connection?: PipenzoGitHubConnectionV1;
    providers?: readonly ProviderStatusV2[];
    providersReject?: boolean;
    disconnect?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const disconnectGitHub =
    options.disconnect ?? vi.fn().mockResolvedValue({ state: 'disconnected', source: 'none' });
  const bridge = {
    pipenzoGitHubConnection: vi.fn().mockResolvedValue(options.connection ?? CONNECTED),
    onDaemonStatus: () => () => {},
    listProvidersV2: options.providersReject
      ? vi.fn().mockRejectedValue(new Error('daemon is not ready yet'))
      : vi.fn().mockResolvedValue(options.providers ?? [provider()]),
    disconnectGitHub,
  };
  setBridgeOverride(bridge as never);
  return bridge;
}

afterEach(() => {
  cleanup();
  clearBridgeOverride();
});

/** Waits past the initial credential read, which every populated case starts from. */
const loaded = () => screen.findByText('octocat');

/**
 * The value in the `owner`-labelled detail row. Scoped rather than a bare `getByText`, because the
 * help text under these rows deliberately repeats `repo` and `gh` -- the disclosure and the value
 * are meant to say the same word, so a global query cannot tell which one it found.
 */
function detailValue(label: string): string {
  const row = screen.getByText(label).closest('.f-row');
  return row?.querySelector('.acct-v')?.textContent ?? '';
}

describe('AccountPanel', () => {
  it('shows the identity, the scope and where the token lives', async () => {
    installBridge();
    render(<AccountPanel />);
    await loaded();

    expect(screen.getByText(/signed in via device flow, 12 Aug 2026/i)).toBeInTheDocument();
    expect(screen.getByText('connected')).toBeInTheDocument();
    expect(detailValue('OAuth scope')).toBe('repo');
    expect(detailValue('Token location')).toBe('Electron-main vault');
  });

  /**
   * The canvas draws `gh CLI — detected · gh stack only` and nothing implements it: `gh` is spawned
   * nowhere in this product, and `gh stack` is post-MVP. Claiming detection in a panel whose job is
   * to say where the credential lives would invite the reader to place `gh` in the publish path.
   */
  it('does not claim to have detected the gh CLI', async () => {
    installBridge();
    render(<AccountPanel />);
    await loaded();

    expect(detailValue('gh CLI')).toBe('not used');
    expect(screen.queryByText(/detected/i)).not.toBeInTheDocument();
    // And the help text carries the reason, so the row is not a bare denial.
    expect(screen.getByText(/never invokes the/i)).toBeInTheDocument();
  });

  /**
   * The surface `daemon-environment.ts` says is owed: a vault that reports `disconnected` while the
   * daemon runs on an inherited `PIPENZO_GITHUB_TOKEN`. The rule against credential fallbacks is a
   * rule against *silent* precedence, so this combination has to be visible rather than inferable.
   */
  it('says so when the daemon is running on an inherited token', async () => {
    installBridge({ connection: { state: 'disconnected', source: 'environment' } });
    render(<AccountPanel />);

    expect(await screen.findByText(/running on an inherited token/i)).toBeVisible();
    // And it does not pretend disconnecting would stop it.
    expect(screen.getByText(/cannot clear a shell variable/i)).toBeInTheDocument();
  });

  it('explains a machine that cannot store a credential', async () => {
    installBridge({
      connection: { state: 'unavailable', reason: 'plaintext_backend', source: 'none' },
    });
    render(<AccountPanel />);

    expect(await screen.findByText(/no usable credential store here/i)).toBeVisible();
    expect(screen.getByText(/published constant key/i)).toBeInTheDocument();
  });

  it('lists the providers agentdock detected', async () => {
    installBridge({
      providers: [
        provider({ authSource: 'claude_subscription' }),
        provider({ id: 'codex' as ProviderStatusV2['id'], name: 'Codex CLI', authenticated: 'unknown' }),
      ],
    });
    render(<AccountPanel />);
    await loaded();

    expect(await screen.findByText('Claude Code CLI')).toBeInTheDocument();
    expect(screen.getByText('authenticated · claude_subscription')).toBeInTheDocument();
    expect(screen.getByText('sign-in unknown')).toBeInTheDocument();
  });

  /** Same rule as the connected-repos list: a failed read is unread, never an empty list. */
  it('reports an unreadable provider list as unread, not as no providers', async () => {
    installBridge({ providersReject: true });
    render(<AccountPanel />);

    expect(await screen.findByText(/could not check your providers/i)).toBeVisible();
    expect(screen.queryByText(/no agent cli was detected/i)).not.toBeInTheDocument();
  });

  /**
   * Disconnecting restarts the daemon, and that restart bypasses the graceful `sessions.cancelAll`
   * -- in-flight work dies uncancelled. `restartDaemonForCredentialChange` called that acceptable
   * only because disconnect was a pre-app action; a button in Settings is reachable mid-run, so the
   * consequence has to be stated before the click that causes it, not after.
   */
  it('does not disconnect on the first click', async () => {
    const bridge = installBridge();
    render(<AccountPanel />);
    await loaded();

    fireEvent.click(screen.getByRole('button', { name: /disconnect github/i }));

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText(/stops without a clean cancel/i)).toBeVisible();
    expect(bridge.disconnectGitHub).not.toHaveBeenCalled();
  });

  it('disconnects once the confirmation is confirmed', async () => {
    const bridge = installBridge();
    render(<AccountPanel />);
    await loaded();

    fireEvent.click(screen.getByRole('button', { name: /disconnect github/i }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Disconnect GitHub' }));

    await waitFor(() => expect(bridge.disconnectGitHub).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('keeps the credential when the confirmation is declined', async () => {
    const bridge = installBridge();
    render(<AccountPanel />);
    await loaded();

    fireEvent.click(screen.getByRole('button', { name: /disconnect github/i }));
    fireEvent.click(await screen.findByRole('button', { name: /keep it connected/i }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(bridge.disconnectGitHub).not.toHaveBeenCalled();
  });

  /**
   * The guard that has to be a ref rather than `pending` or `disabled`. `Button` deliberately keeps
   * a pending button focusable and drops the interaction through `onClick={pending ? undefined :
   * onClick}` -- which is state, so two clicks dispatched before React commits either one both see
   * `pending === false` and both fire. `useAsyncAction` does not close it either: its `callIdRef`
   * picks which *outcome* commits, not whether a second call starts.
   *
   * Two disconnects is not a harmless repeat. Each one restarts the daemon and kills every running
   * session uncancelled, which is the unbounded-restart-loop shape this channel has already had a
   * real bug in once.
   *
   * The nested `act` is what makes it one batch: React holds the render queue until the outermost
   * scope exits, so the second click lands before the first has rendered. Two bare `fireEvent`
   * calls do not reproduce it, because each one flushes on its own.
   */
  it('will not start a second disconnect in the same batch as the first', async () => {
    let release: (() => void) | undefined;
    const disconnect = vi.fn(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ state: 'disconnected', source: 'none' });
        }),
    );
    const bridge = installBridge({ disconnect });
    render(<AccountPanel />);
    await loaded();

    fireEvent.click(screen.getByRole('button', { name: /disconnect github/i }));
    const dialog = await screen.findByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: 'Disconnect GitHub' });

    act(() => {
      fireEvent.click(confirm);
      fireEvent.click(confirm);
    });

    expect(bridge.disconnectGitHub).toHaveBeenCalledTimes(1);
    release?.();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  /**
   * A failed disconnect leaves the dialog open with the reason in it -- the one moment the user
   * most needs the control still in front of them -- and the latch must be clear so the retry
   * actually goes out. A guard released only on the success path is a button that is permanently
   * inert after one failure.
   */
  it('keeps the dialog open on failure and allows a retry', async () => {
    const disconnect = vi
      .fn()
      .mockRejectedValueOnce(new Error('the vault refused the write.'))
      .mockResolvedValueOnce({ state: 'disconnected', source: 'none' });
    const bridge = installBridge({ disconnect });
    render(<AccountPanel />);
    await loaded();

    fireEvent.click(screen.getByRole('button', { name: /disconnect github/i }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Disconnect GitHub' }));

    expect(await screen.findByText(/could not disconnect/i)).toBeVisible();
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Disconnect GitHub' }));
    await waitFor(() => expect(bridge.disconnectGitHub).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  /** The panel must not read local state off the disconnect reply -- see `main.ts`. */
  it('does not render the disconnect reply as the new connection', async () => {
    const disconnect = vi.fn().mockResolvedValue({ state: 'disconnected', source: 'none' });
    installBridge({ disconnect });
    render(<AccountPanel />);
    await loaded();

    fireEvent.click(screen.getByRole('button', { name: /disconnect github/i }));
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Disconnect GitHub' }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    // Still `octocat`: the reply describes the daemon on its way out, and the hook re-reads on the
    // next `daemon:status` `ready`, which is when the new daemon's credential takes effect.
    expect(screen.getByText('octocat')).toBeInTheDocument();
  });
});
