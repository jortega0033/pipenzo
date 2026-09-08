import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PipenzoRepoV1 } from '@agent-dock/shared';
import { clearBridgeOverride, setBridgeOverride } from '../../src/bridge.js';
import { RepoPicker } from '../../src/pipenzo/RepoPicker.js';

const repo = (fullName: string, overrides: Partial<PipenzoRepoV1> = {}): PipenzoRepoV1 => ({
  fullName,
  archived: false,
  defaultBranch: 'main',
  openIssues: 0,
  ...overrides,
});

const REPOS = [
  repo('octocat/hello-world', { language: 'TypeScript', openIssues: 15 }),
  repo('octocat/spoon-knife', { openIssues: 1 }),
  repo('octocat/retired', { archived: true }),
];

function installBridge(
  options: {
    repositories?: readonly PipenzoRepoV1[];
    connected?: readonly string[];
    truncated?: boolean;
    listRejects?: boolean;
    connectRejects?: Error;
  } = {},
) {
  const pipenzoConnectRepos = options.connectRejects
    ? vi.fn().mockRejectedValue(options.connectRejects)
    : vi.fn(async (input: { repositories: string[] }) => ({ repositories: input.repositories }));
  const bridge = {
    pipenzoListRepos: options.listRejects
      ? vi.fn().mockRejectedValue(new Error('daemon is not ready yet'))
      : vi.fn().mockResolvedValue({
          repositories: options.repositories ?? REPOS,
          truncated: options.truncated ?? false,
        }),
    pipenzoConnectedRepos: vi.fn().mockResolvedValue({ repositories: options.connected ?? [] }),
    pipenzoConnectRepos,
  };
  setBridgeOverride(bridge as never);
  return bridge;
}

afterEach(() => {
  cleanup();
  clearBridgeOverride();
});

/** Waits for the list to arrive, which every populated case starts from. */
const listed = () => screen.findByRole('checkbox', { name: /octocat\/hello-world/ });

describe('RepoPicker', () => {
  it('lists what the credential can write to, with the branch, language and issue count', async () => {
    installBridge();
    render(<RepoPicker />);
    await listed();

    expect(screen.getByText('main · TypeScript · 15 open issues')).toBeInTheDocument();
    // Singular, because "1 open issues" is the kind of thing that makes a UI look unfinished.
    expect(screen.getByText('main · 1 open issue')).toBeInTheDocument();
  });

  it('starts with whatever is already connected already ticked', async () => {
    installBridge({ connected: ['octocat/spoon-knife'] });
    render(<RepoPicker />);
    await listed();

    expect(screen.getByRole('checkbox', { name: /spoon-knife/ })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByRole('checkbox', { name: /hello-world/ })).toHaveAttribute(
      'aria-checked',
      'false',
    );
    expect(screen.getByText('1 repo selected')).toBeInTheDocument();
  });

  /**
   * The ticket's actual acceptance criterion. The row is *listed* — omitting it would read as
   * Pipenzo being unable to see the repository at all — and it cannot be chosen, because no pull
   * request can be opened against an archived repository.
   */
  it('lists an archived repository and refuses to select it', async () => {
    const bridge = installBridge();
    render(<RepoPicker />);
    await listed();

    const archived = screen.getByRole('checkbox', { name: /retired/ });
    expect(archived).toBeInTheDocument();
    expect(archived).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByText('archived on GitHub — no PR can be opened against it')).toBeInTheDocument();
    expect(screen.getByText('read-only')).toBeInTheDocument();

    fireEvent.click(archived);
    expect(archived).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText('0 repos selected')).toBeInTheDocument();
    expect(bridge.pipenzoConnectRepos).not.toHaveBeenCalled();
  });

  it('toggles a row and keeps a running count', async () => {
    installBridge();
    render(<RepoPicker />);
    await listed();

    fireEvent.click(screen.getByRole('checkbox', { name: /hello-world/ }));
    expect(screen.getByText('1 repo selected')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: /spoon-knife/ }));
    expect(screen.getByText('2 repos selected')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('checkbox', { name: /hello-world/ }));
    expect(screen.getByText('1 repo selected')).toBeInTheDocument();
  });

  it('filters as you type, over the whole list rather than a page of it', async () => {
    installBridge();
    render(<RepoPicker />);
    await listed();

    // The count is in the placeholder, and answers "did it find everything?" before you type.
    expect(screen.getByPlaceholderText('Filter 3 accessible repositories…')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Filter repositories'), { target: { value: 'spoon' } });
    expect(screen.queryByRole('checkbox', { name: /hello-world/ })).not.toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /spoon-knife/ })).toBeInTheDocument();
  });

  /** A filter that matches nothing has to say so; an empty box reads as a broken list. */
  it('says when a filter matches nothing', async () => {
    installBridge();
    render(<RepoPicker />);
    await listed();

    fireEvent.change(screen.getByLabelText('Filter repositories'), {
      target: { value: 'nothing-like-this' },
    });
    expect(screen.getByText('No repository matches that filter')).toBeInTheDocument();
  });

  /**
   * Selection survives filtering. Typing to find a second repository must not silently drop the
   * first one, which it would if the selection were derived from the visible rows.
   */
  it('keeps a selection that the filter has hidden', async () => {
    const bridge = installBridge();
    render(<RepoPicker />);
    await listed();

    fireEvent.click(screen.getByRole('checkbox', { name: /hello-world/ }));
    fireEvent.change(screen.getByLabelText('Filter repositories'), { target: { value: 'spoon' } });
    expect(screen.getByText('1 repo selected')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('checkbox', { name: /spoon-knife/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Connect 2 repos' }));
    await waitFor(() => expect(bridge.pipenzoConnectRepos).toHaveBeenCalled());
    expect(bridge.pipenzoConnectRepos).toHaveBeenCalledWith({
      repositories: ['octocat/hello-world', 'octocat/spoon-knife'],
    });
  });

  it('writes the selection and reports the saved list', async () => {
    const bridge = installBridge();
    const onConnected = vi.fn();
    render(<RepoPicker onConnected={onConnected} />);
    await listed();

    fireEvent.click(screen.getByRole('checkbox', { name: /hello-world/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Connect 1 repo' }));

    await waitFor(() => expect(onConnected).toHaveBeenCalledWith(['octocat/hello-world']));
    expect(bridge.pipenzoConnectRepos).toHaveBeenCalledWith({
      repositories: ['octocat/hello-world'],
    });
  });

  /** Zero is not a way to finish first-run, and the CTA says so by not being pressable. */
  it('cannot be submitted with nothing selected', async () => {
    installBridge();
    render(<RepoPicker />);
    await listed();

    expect(screen.getByRole('button', { name: 'Connect 0 repos' })).toBeDisabled();
  });

  it('reports a failed save without losing the selection', async () => {
    const bridge = installBridge({ connectRejects: new Error('daemon is not ready yet') });
    render(<RepoPicker />);
    await listed();

    fireEvent.click(screen.getByRole('checkbox', { name: /hello-world/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Connect 1 repo' }));

    expect(await screen.findByText('Could not save your selection')).toBeInTheDocument();
    // Still ticked, so the user can simply press the button again.
    expect(screen.getByRole('checkbox', { name: /hello-world/ })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(bridge.pipenzoConnectRepos).toHaveBeenCalledTimes(1);
  });

  /**
   * The daemon is what talks to GitHub, and it rejects this call while it is still starting -- which
   * is the common case right after a sign-in, since connecting restarts it. So a failure has to be
   * recoverable in place rather than a dead screen.
   */
  it('offers a retry when the list cannot be loaded', async () => {
    installBridge({ listRejects: true });
    render(<RepoPicker />);

    expect(await screen.findByText('Could not load your repositories')).toBeInTheDocument();
    // And it does not guess at a cause it cannot know.
    expect(screen.queryByText(/permission/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('explains an account with nothing it can manage', async () => {
    installBridge({ repositories: [] });
    render(<RepoPicker />);

    expect(await screen.findByText('No repositories Pipenzo can manage')).toBeInTheDocument();
    // The reason matters: a read-only repository is absent by design, not by accident.
    expect(screen.getByText(/could never manage one/)).toBeInTheDocument();
  });

  /** A complete-looking list that is not complete is worse than a short one that says so. */
  it('says when even the daemon hit its page cap', async () => {
    installBridge({ truncated: true });
    render(<RepoPicker />);
    await listed();

    expect(screen.getByText('This list is not complete')).toBeInTheDocument();
  });

  it('lets a caller relabel the CTA, for Settings', async () => {
    installBridge({ connected: ['octocat/hello-world'] });
    render(<RepoPicker ctaLabel={(count) => `Save ${count}`} />);
    await listed();

    expect(screen.getByRole('button', { name: 'Save 1' })).toBeInTheDocument();
  });
});
