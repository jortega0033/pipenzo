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

    // Scoped to the row. A global `queryByText(/detected/i)` would also match the empty-provider
    // copy ("No agent CLI was detected on this machine"), so it would pass or fail on the fixture's
    // provider list rather than on the claim this test is about.
    expect(detailValue('gh CLI')).toBe('not used');
    expect(detailValue('gh CLI')).not.toMatch(/detected/i);
    // And the help text carries the reason, so the row is not a bare denial.
    expect(screen.getByText(/never invokes the/i)).toBeInTheDocument();
  });

  /**
   * The surface `daemon-environment.ts` says is owed: a vault that reports `disconnected` while the
   * daemon runs on the development fallback (a file, issue #212 -- an inherited shell variable
   * before that). The rule against credential fallbacks is a rule against *silent* precedence, so
   * this combination has to be visible rather than inferable.
   */
  it('says so when the daemon is running on the development fallback', async () => {
    installBridge({ connection: { state: 'disconnected', source: 'environment' } });
    render(<AccountPanel />);

    expect(await screen.findByText(/running on the development fallback/i)).toBeVisible();
    // And it says accurately what disconnecting now does (issue #210): stops the daemon from
    // re-arming onto the fallback this run, though it comes back on the next restart.
    expect(screen.getByText(/disconnecting now stops it too/i)).toBeInTheDocument();
  });

  it('explains a machine that cannot store a credential', async () => {
    installBridge({
      connection: { state: 'unavailable', reason: 'plaintext_backend', source: 'none' },
    });
    render(<AccountPanel />);

    expect(await screen.findByText(/no usable credential store here/i)).toBeVisible();
    expect(screen.getByText(/published constant key/i)).toBeInTheDocument();
  });

  /**
   * `unavailable` is not `empty`. `status()` resolves availability before it looks for a record, and
   * `unreadable` is returned only after `existsSync` has already passed -- so that state guarantees
   * a record IS on disk, and `clear()` would remove it. Hiding the button here left the panel saying
   * "a stored record exists but cannot be decrypted" beside no way to remove it, on a machine where
   * `store()` refuses so nothing could overwrite it either. Clearing is the recovery, not a no-op.
   */
  it('still offers a disconnect for a record this machine cannot decrypt', async () => {
    const bridge = installBridge({
      connection: { state: 'unavailable', reason: 'unreadable', source: 'none' },
    });
    render(<AccountPanel />);
    await screen.findByText(/no usable credential store here/i);

    const button = screen.getByRole('button', { name: /disconnect github/i });
    expect(button).toBeInTheDocument();
    expect(screen.getByText(/removes the stored record this machine cannot read/i)).toBeVisible();

    fireEvent.click(button);
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Disconnect GitHub' }),
    );
    await waitFor(() => expect(bridge.disconnectGitHub).toHaveBeenCalledTimes(1));
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
   * The notice names a cause that stops being true -- the daemon rejects this while it is starting,
   * and the disconnect on this panel restarts it -- so it has to offer a way to re-ask. Without
   * this the only exit is leaving Settings and coming back.
   */
  it('can retry the provider read', async () => {
    const bridge = installBridge({ providersReject: true });
    render(<AccountPanel />);
    await screen.findByText(/could not check your providers/i);

    bridge.listProvidersV2.mockResolvedValue([provider()]);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByText('Claude Code CLI')).toBeInTheDocument();
    expect(bridge.listProvidersV2).toHaveBeenCalledTimes(2);
  });

  /**
   * The panel's own security copy, which two review passes caught asserting something false. The
   * token does leave Electron main: `main.ts` writes it to the daemon's stdin at spawn, and
   * `github-credential.ts` says in as many words that the stdin handoff is "defence in depth, not a
   * boundary, and saying otherwise would be the kind of claim this codebase is supposed to refuse
   * to make". The true, narrower claims are the ones worth pinning.
   */
  it('does not claim the token never leaves Electron main', async () => {
    installBridge();
    render(<AccountPanel />);
    await loaded();

    expect(screen.queryByText(/never leaves the electron main process/i)).not.toBeInTheDocument();
    expect(screen.getByText(/never sitting in a variable a subprocess could print/i)).toBeVisible();
    expect(screen.getByText(/no provider subprocess receives it/i)).toBeInTheDocument();
    // And it must not derive an impossibility from the pipe. On Windows, reading a same-user
    // process's environment block and reading its heap are the same OpenProcess +
    // ReadProcessMemory, so "cannot read it out of its parent" is false on the packaging platform
    // -- `github-credential.ts` calls the stdin handoff defence in depth, not a boundary.
    expect(screen.queryByText(/read it out of its parent/i)).not.toBeInTheDocument();
  });

  /**
   * `tokenVault.clear()` reports whether it removed anything, and `main.ts` restarts the daemon only
   * when it did. On an empty vault the call resolves having done nothing at all -- so offering the
   * button there would let the panel close its dialog and read as though it had acted.
   */
  it('offers no disconnect when there is nothing stored to clear', async () => {
    installBridge({ connection: { state: 'disconnected', source: 'none' } });
    render(<AccountPanel />);
    await screen.findByText(/nothing is stored on this machine/i);

    expect(screen.queryByRole('button', { name: /disconnect github/i })).not.toBeInTheDocument();
  });

  /**
   * The vault can hold a record while the daemon is running on the development fallback -- a
   * daemon spawned before the vault was written. Disconnecting now stops that fallback too (issue
   * #210), so the dialog must say so accurately, while still not promising a GitHub-side
   * revocation it cannot perform -- device flow is a public client with no client secret to
   * authenticate that API call with.
   */
  it('says a disconnect stops the development fallback from re-arming, but still cannot revoke it', async () => {
    installBridge({
      connection: { state: 'connected', login: 'octocat', source: 'environment' },
    });
    render(<AccountPanel />);
    await loaded();

    fireEvent.click(screen.getByRole('button', { name: /disconnect github/i }));
    const dialog = await screen.findByRole('dialog');

    expect(within(dialog).getByText(/stops it from using that file/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/stays valid on GitHub until you revoke it/i)).toBeInTheDocument();
  });

  /**
   * Issue #210's other half: every disconnect, not only the inherited-token case, forgets the
   * token locally without revoking it on GitHub -- Pipenzo has no client secret to authenticate a
   * revocation call with. The dialog owes a direct, working link to where a human does that
   * themselves, not just a mention of it.
   */
  it('links directly to the GitHub page a human revokes access from', async () => {
    installBridge({ connection: CONNECTED });
    render(<AccountPanel />);
    await loaded();

    fireEvent.click(screen.getByRole('button', { name: /disconnect github/i }));
    const dialog = await screen.findByRole('dialog');

    const link = within(dialog).getByRole('link', { name: /github\.com\/settings\/applications/i });
    expect(link).toHaveAttribute('href', 'https://github.com/settings/applications');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noreferrer');
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
