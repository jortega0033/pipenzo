import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SyncStatusPill } from '../../src/components/primitives/SyncStatusPill.js';

describe('SyncStatusPill', () => {
  it('renders the synced rendering with no slow class and an enabled refresh button', () => {
    const { container } = render(
      <SyncStatusPill status="synced" label="Synced 38s ago" onRefresh={vi.fn()} />,
    );
    expect(container.querySelector('.sync-status')?.className).toBe('sync-status');
    expect(screen.getByText(/Synced 38s ago/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh now' })).toBeEnabled();
  });

  it('renders the syncing rendering with a spinning icon and a disabled refresh button', () => {
    const { container } = render(
      <SyncStatusPill status="syncing" label="Syncing…" onRefresh={vi.fn()} />,
    );
    expect(container.querySelector('.sync-status')?.className).toBe('sync-status');
    expect(container.querySelector('.icon-sm')?.getAttribute('class')).toContain('spin');
    expect(screen.getByRole('button', { name: 'Refresh now' })).toBeDisabled();
  });

  it('renders the syncing-slowly rendering with the slow class and an enabled refresh button', () => {
    const { container } = render(
      <SyncStatusPill status="slow" label="Syncing slowly · next poll in 4m" onRefresh={vi.fn()} />,
    );
    expect(container.querySelector('.sync-status')?.className).toBe('sync-status slow');
    expect(screen.getByRole('button', { name: 'Refresh now' })).toBeEnabled();
  });

  it('calls onRefresh when the refresh button is clicked, without changing status itself', () => {
    const onRefresh = vi.fn();
    render(<SyncStatusPill status="synced" label="Synced 38s ago" onRefresh={onRefresh} />);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh now' }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});
