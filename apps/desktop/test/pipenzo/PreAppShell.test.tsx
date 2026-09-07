import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ConnectPane, ConnectStepBar, PreAppShell } from '../../src/pipenzo/PreAppShell.js';

describe('PreAppShell', () => {
  it('renders the topbar and centred column, and nothing else', () => {
    const { container } = render(
      <PreAppShell step="device-code" canChooseRepos={false} onStepChange={vi.fn()}>
        step content
      </PreAppShell>,
    );

    expect(container.querySelector('.preapp')).toBeInTheDocument();
    expect(container.querySelector('.topbar')).toBeInTheDocument();
    expect(container.querySelector('.center')).toBeInTheDocument();
    expect(screen.getByText('step content')).toBeInTheDocument();
  });

  /**
   * The absence is the design, not an omission: before a credential exists there is no workspace,
   * so a sidebar, workspace switcher or breadcrumb bar here would be navigation that leads nowhere.
   * Asserted rather than assumed, because "just reuse AppShell" is the obvious wrong turn for
   * whoever touches this next.
   */
  it('has no sidebar, workspace row or breadcrumb bar', () => {
    const { container } = render(
      <PreAppShell step="device-code" canChooseRepos={false} onStepChange={vi.fn()}>
        x
      </PreAppShell>,
    );

    for (const selector of ['.shell', '.sidebar', '.main', '.main-head', '.crumbs', '.ws']) {
      expect(container.querySelector(selector)).toBeNull();
    }
  });

  it('reuses the sidebar brand classes rather than restyling them', () => {
    const { container } = render(
      <PreAppShell step="device-code" canChooseRepos={false} onStepChange={vi.fn()}>
        x
      </PreAppShell>,
    );

    expect(container.querySelector('.brand .logo-mark')).toBeInTheDocument();
    expect(container.querySelector('.brand .wordmark')?.textContent).toBe('pipenzo');
  });
});

describe('ConnectStepBar', () => {
  it('renders both canvas labels on the shared .seg pill', () => {
    const { container } = render(
      <ConnectStepBar step="device-code" canChooseRepos onStepChange={vi.fn()} />,
    );

    // `.steps` alongside `.seg`: the shared pill's visuals, this component's own disabled rule.
    // Unscoped, the next `Segmented`-based switch to gain a disabled option would inherit it.
    expect(container.querySelector('.seg.steps')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '1 · Device code' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '2 · Choose repos' })).toBeInTheDocument();
  });

  /**
   * `aria-current="step"` rather than `aria-pressed`, which is why this is not the `Segmented`
   * primitive: "this toggle is on" and "this is the step you are on" are different statements, and
   * only the second one is true here.
   */
  it('marks the current step as the current step', () => {
    render(<ConnectStepBar step="choose-repos" canChooseRepos onStepChange={vi.fn()} />);

    const step2 = screen.getByRole('button', { name: '2 · Choose repos' });
    expect(step2).toHaveAttribute('aria-current', 'step');
    expect(step2.className).toBe('active');
    expect(screen.getByRole('button', { name: '1 · Device code' })).not.toHaveAttribute(
      'aria-current',
    );
  });

  /**
   * It looks like a tab bar and it is not one. `role="tablist"`/`role="tab"` is a commitment to the
   * ARIA tabs pattern -- `aria-controls` onto a real `role="tabpanel"`, plus roving-tabindex arrow
   * navigation -- and claiming the role without implementing the pattern is worse than not claiming
   * it: a screen reader announces "tab 1 of 2" and then the arrow keys do nothing. This is a wizard
   * step indicator, so it is a plain button group carrying `aria-current="step"`.
   *
   * Asserted as an absence because that is the shape of the mistake: the roles read as an
   * improvement to whoever adds them back.
   */
  it('does not claim the tabs pattern it does not implement', () => {
    const { container } = render(
      <ConnectStepBar step="device-code" canChooseRepos onStepChange={vi.fn()} />,
    );

    expect(container.querySelector('[role="tablist"]')).toBeNull();
    expect(container.querySelector('[role="tab"]')).toBeNull();
    expect(container.querySelector('[aria-selected]')).toBeNull();
    expect(screen.getByRole('group', { name: 'Connect steps' })).toBeInTheDocument();
  });

  it('makes step 2 unreachable, not merely unstyled, without a credential', () => {
    const onStepChange = vi.fn();
    render(<ConnectStepBar step="device-code" canChooseRepos={false} onStepChange={onStepChange} />);

    const step2 = screen.getByRole('button', { name: '2 · Choose repos' });
    expect(step2).toBeDisabled();
    fireEvent.click(step2);
    expect(onStepChange).not.toHaveBeenCalled();
  });

  it('still allows going back to the device code once step 2 is reachable', () => {
    const onStepChange = vi.fn();
    render(<ConnectStepBar step="choose-repos" canChooseRepos onStepChange={onStepChange} />);

    fireEvent.click(screen.getByRole('button', { name: '1 · Device code' }));
    expect(onStepChange).toHaveBeenCalledWith('device-code');
  });
});

describe('ConnectPane', () => {
  it('renders the heading pair, body and action row', () => {
    const { container } = render(
      <ConnectPane title="Connect GitHub" subtitle="why" actions={<button>Go</button>}>
        body
      </ConnectPane>,
    );

    expect(container.querySelector('.pane')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Connect GitHub' }).className).toBe('pane-title');
    expect(container.querySelector('.pane-sub')?.textContent).toBe('why');
    expect(container.querySelector('.pane-acts')).toBeInTheDocument();
    expect(screen.getByText('body')).toBeInTheDocument();
  });

  it('omits the sub and action row when it has nothing to put in them', () => {
    const { container } = render(<ConnectPane title="t" />);
    expect(container.querySelector('.pane-sub')).toBeNull();
    expect(container.querySelector('.pane-acts')).toBeNull();
  });
});
