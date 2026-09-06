import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  AppShell,
  Crumbs,
  MainHead,
  MainHeadRight,
  NavGroup,
  NavItem,
  Sidebar,
  SidebarBrand,
  SidebarFoot,
  SidebarUser,
} from '../../src/components/primitives/AppShell.js';

describe('AppShell/Sidebar', () => {
  it('renders the sidebar and main columns', () => {
    const { container } = render(
      <AppShell sidebar={<Sidebar>sidebar content</Sidebar>}>main content</AppShell>,
    );
    expect(container.querySelector('.shell')).toBeInTheDocument();
    expect(container.querySelector('.sidebar')).toBeInTheDocument();
    expect(container.querySelector('.main')).toBeInTheDocument();
    expect(screen.getByText('main content')).toBeInTheDocument();
  });

  it('applies the collapsed class', () => {
    const { container } = render(<Sidebar collapsed>x</Sidebar>);
    expect(container.querySelector('.sidebar')?.className).toBe('sidebar collapsed');
  });

  it('renders the brand mark and wordmark', () => {
    render(<SidebarBrand />);
    expect(screen.getByText('p')).toBeInTheDocument();
    expect(screen.getByText('pipenzo')).toBeInTheDocument();
  });
});

describe('NavGroup/NavItem', () => {
  it('renders a titled group with nav items', () => {
    const { container } = render(
      <NavGroup title="Work">
        <NavItem icon="board" active count={15}>
          Board
        </NavItem>
        <NavItem icon="needs-human" count={7} hot>
          Needs me
        </NavItem>
      </NavGroup>,
    );
    expect(screen.getByText('Work')).toBeInTheDocument();
    expect(screen.getByText('Board')).toBeInTheDocument();
    const items = container.querySelectorAll('.nav-item');
    expect(items[0]!.className).toBe('nav-item active');
    expect(container.querySelector('.nav-count.hot')).toBeInTheDocument();
  });

  it('omits the trailing count when not given', () => {
    const { container } = render(<NavItem icon="activity">Activity</NavItem>);
    expect(container.querySelector('.nav-count')).not.toBeInTheDocument();
  });

  it('renders the kbd-styled count for the Collapse row', () => {
    const { container } = render(
      <NavItem icon="sidebar" count="[" kbd>
        Collapse
      </NavItem>,
    );
    expect(container.querySelector('.nav-count.kbd')?.textContent).toBe('[');
  });

  it('is keyboard-actionable: calls onClick on click and Enter/Space', () => {
    const onClick = vi.fn();
    render(
      <NavItem icon="board" onClick={onClick}>
        Board
      </NavItem>,
    );
    const item = screen.getByRole('button');
    fireEvent.click(item);
    fireEvent.keyDown(item, { key: 'Enter' });
    fireEvent.keyDown(item, { key: ' ' });
    fireEvent.keyDown(item, { key: 'a' });
    expect(onClick).toHaveBeenCalledTimes(3);
  });
});

describe('SidebarFoot/SidebarUser', () => {
  it('renders the user row and calls onClick', () => {
    const onClick = vi.fn();
    render(
      <SidebarFoot>
        <SidebarUser initials="JO" name="Jake Ortega" sub="Expert mode" onClick={onClick} />
      </SidebarFoot>,
    );
    expect(screen.getByText('Jake Ortega')).toBeInTheDocument();
    expect(screen.getByText('Expert mode')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe('MainHead/Crumbs', () => {
  it('renders crumbs with a caret separator and bolds the last item', () => {
    const { container } = render(
      <MainHead>
        <Crumbs items={[<span className="mono">jortega0033/agentdock</span>, 'Board']} />
        <MainHeadRight>actions</MainHeadRight>
      </MainHead>,
    );
    expect(container.querySelectorAll('.crumbs svg')).toHaveLength(1);
    expect(container.querySelector('.cur')?.textContent).toBe('Board');
    expect(screen.getByText('actions')).toBeInTheDocument();
  });

  it('renders no separator for a single crumb', () => {
    const { container } = render(<Crumbs items={['Board']} />);
    expect(container.querySelectorAll('.crumbs svg')).toHaveLength(0);
    expect(container.querySelector('.cur')?.textContent).toBe('Board');
  });
});
