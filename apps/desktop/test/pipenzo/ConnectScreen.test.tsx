import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ConnectScreen } from '../../src/pipenzo/ConnectScreen.js';

/**
 * `AppRoot.test.tsx` covers the gate end to end, from a real bridge answer to a rendered screen.
 * This file covers what that path cannot reach yet: **step 2**.
 *
 * Nothing in the shipped app passes a `connectedRepos` count, so `routePipenzoStartup` never
 * returns `{ step: 'choose-repos' }` in production today -- #115 is what starts passing one. The
 * step is built and routable now because the two-step shell is this ticket's whole subject, and it
 * is tested here against exactly the route #115 will produce, so it does not ship as an untested
 * branch waiting for a caller.
 */
describe('ConnectScreen', () => {
  it('shows the device-code step for a token-less install', () => {
    render(
      <ConnectScreen route={{ screen: 'pre-app', step: 'device-code', canChooseRepos: false }} />,
    );

    expect(screen.getByRole('heading', { name: 'Connect GitHub' })).toBeInTheDocument();
    expect(screen.getByText(/issue #114/)).toBeInTheDocument();
    // No "cannot store" notice on a healthy machine that simply has not connected yet.
    expect(screen.queryByText(/cannot store a token/i)).not.toBeInTheDocument();
  });

  it('shows the repo step on the route #115 will produce', () => {
    render(
      <ConnectScreen route={{ screen: 'pre-app', step: 'choose-repos', canChooseRepos: true }} />,
    );

    expect(
      screen.getByRole('heading', { name: 'Choose the repos Pipenzo manages' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/issue #115/)).toBeInTheDocument();
  });

  it('lets the user move between steps once both are reachable', () => {
    render(
      <ConnectScreen route={{ screen: 'pre-app', step: 'choose-repos', canChooseRepos: true }} />,
    );

    fireEvent.click(screen.getByRole('tab', { name: '1 · Device code' }));
    expect(screen.getByRole('heading', { name: 'Connect GitHub' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: '2 · Choose repos' }));
    expect(
      screen.getByRole('heading', { name: 'Choose the repos Pipenzo manages' }),
    ).toBeInTheDocument();
  });

  /**
   * The user's own navigation must never outrank the route. If a disconnect lands while step 2 is
   * on screen, the next render has `canChooseRepos: false` and the screen has to fall back rather
   * than keep showing a picker with nothing behind it.
   */
  it('drops a held step-2 selection when the credential goes away', () => {
    const { rerender } = render(
      <ConnectScreen route={{ screen: 'pre-app', step: 'choose-repos', canChooseRepos: true }} />,
    );
    fireEvent.click(screen.getByRole('tab', { name: '2 · Choose repos' }));

    rerender(
      <ConnectScreen route={{ screen: 'pre-app', step: 'device-code', canChooseRepos: false }} />,
    );
    expect(screen.getByRole('heading', { name: 'Connect GitHub' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '2 · Choose repos' })).toBeDisabled();
  });

  it('names the specific reason a machine cannot hold a credential', () => {
    render(
      <ConnectScreen
        route={{
          screen: 'pre-app',
          step: 'device-code',
          canChooseRepos: false,
          unavailableReason: 'os_encryption_unavailable',
        }}
      />,
    );

    expect(screen.getByText(/no OS credential store/i)).toBeInTheDocument();
  });
});
