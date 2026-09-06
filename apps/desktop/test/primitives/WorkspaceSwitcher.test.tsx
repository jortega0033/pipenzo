import { fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  WorkspaceSwitcher,
  type WorkspaceSwitcherRepo,
} from '../../src/components/primitives/WorkspaceSwitcher.js';

const REPOS: WorkspaceSwitcherRepo[] = [
  { id: 'ad', monogram: 'ad', name: 'jortega0033/agentdock', subline: 'main · 15 open · 2 running' },
  { id: 'pz', monogram: 'pz', name: 'jortega0033/pipenzo', subline: 'main · 3 open · idle' },
  {
    id: 'ov',
    monogram: 'ov',
    name: 'jortega0033/open-vacancy-radar',
    subline: 'master · 5 open · 1 needs you',
  },
];

function Harness({
  onSelectRepo,
  onManageRepos,
}: {
  onSelectRepo: (id: string) => void;
  onManageRepos: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [activeRepoId, setActiveRepoId] = useState('ad');
  return (
    <WorkspaceSwitcher
      open={open}
      onOpenChange={setOpen}
      repos={REPOS}
      activeRepoId={activeRepoId}
      onSelectRepo={(id) => {
        setActiveRepoId(id);
        onSelectRepo(id);
      }}
      onManageRepos={onManageRepos}
      manageReposNote="Only these three are polled. Adding or removing one opens the same searchable picker as first-run, in Settings."
    />
  );
}

describe('WorkspaceSwitcher', () => {
  it('renders the active repo on the trigger, panel closed', () => {
    render(<Harness onSelectRepo={vi.fn()} onManageRepos={vi.fn()} />);
    expect(screen.getByRole('button', { name: /jortega0033\/agentdock/ })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('opens the menu listing every connected repo with name and subline', () => {
    render(<Harness onSelectRepo={vi.fn()} onManageRepos={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /jortega0033\/agentdock/ }));

    const menu = within(screen.getByRole('dialog'));
    expect(menu.getByText('Connected repos · 3')).toBeInTheDocument();
    expect(menu.getByText('main · 15 open · 2 running')).toBeInTheDocument();
    expect(menu.getByText('main · 3 open · idle')).toBeInTheDocument();
    expect(menu.getByText('master · 5 open · 1 needs you')).toBeInTheDocument();
  });

  it('marks the active repo row and shows the check only there', () => {
    render(<Harness onSelectRepo={vi.fn()} onManageRepos={vi.fn()} />);
    fireEvent.click(screen.getAllByRole('button', { name: /jortega0033\/agentdock/ })[0]!);

    const rows = screen.getAllByRole('button', { name: /jortega0033/ });
    const activeRow = rows.find((row) => row.className.includes('active'));
    expect(activeRow).toHaveTextContent('jortega0033/agentdock');
  });

  it('switches the active repo on click and closes the menu', () => {
    const onSelectRepo = vi.fn();
    render(<Harness onSelectRepo={onSelectRepo} onManageRepos={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /jortega0033\/agentdock/ }));
    fireEvent.click(screen.getByRole('button', { name: /jortega0033\/pipenzo/ }));

    expect(onSelectRepo).toHaveBeenCalledWith('pz');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('calls onManageRepos from the footer row and shows the read-only note', () => {
    const onManageRepos = vi.fn();
    render(<Harness onSelectRepo={vi.fn()} onManageRepos={onManageRepos} />);
    fireEvent.click(screen.getByRole('button', { name: /jortega0033\/agentdock/ }));

    expect(screen.getByText(/Adding or removing one opens the same searchable picker/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Manage repos/ }));
    expect(onManageRepos).toHaveBeenCalledTimes(1);
  });

  it('closes on Escape', () => {
    render(<Harness onSelectRepo={vi.fn()} onManageRepos={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /jortega0033\/agentdock/ }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
