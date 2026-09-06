import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Toast, ToastStack, useToastStack, type ToastInput } from '../../src/components/primitives/Toast.js';

function Harness({ limit }: { limit?: number }) {
  const { visible, push, dismiss } = useToastStack({ limit });
  return (
    <div>
      <button
        onClick={() =>
          push({ icon: 'check-circle', tone: 'ok', title: 'Branch pushed', description: 'issue-94 → origin' })
        }
      >
        Push plain
      </button>
      <button
        onClick={() =>
          push({
            icon: 'git-pull-request',
            title: 'PR #112 opened',
            action: { label: 'Open', onClick: vi.fn() },
          })
        }
      >
        Push with action
      </button>
      <ToastStack toasts={visible} onDismiss={dismiss} />
    </div>
  );
}

describe('Toast', () => {
  it('renders tone, icon, title, description and one action', () => {
    const toast: ToastInput = {
      tone: 'warn',
      icon: 'warning',
      title: "#87 moved to Needs human",
      description: '3 failed attempts',
      action: { label: 'Retry with note', onClick: vi.fn() },
    };
    const { container } = render(<Toast {...toast} />);
    expect(container.querySelector('.toast')?.className).toBe('toast warn');
    expect(screen.getByText("#87 moved to Needs human")).toBeInTheDocument();
    expect(screen.getByText('3 failed attempts')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry with note' })).toBeInTheDocument();
  });
});

describe('useToastStack + ToastStack', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders nothing when there are no toasts', () => {
    render(<Harness />);
    expect(screen.queryByText(/Branch pushed/)).not.toBeInTheDocument();
  });

  it('shows a pushed toast immediately, newest last in DOM order', () => {
    render(<Harness />);
    act(() => fireEvent.click(screen.getByRole('button', { name: 'Push plain' })));
    act(() => fireEvent.click(screen.getByRole('button', { name: 'Push with action' })));

    const titles = screen.getAllByText(/Branch pushed|PR #112 opened/).map((el) => el.textContent);
    expect(titles).toEqual(['Branch pushed', 'PR #112 opened']);
  });

  it('auto-dismisses a toast with no action after 6s', () => {
    render(<Harness />);
    act(() => fireEvent.click(screen.getByRole('button', { name: 'Push plain' })));
    expect(screen.getByText('Branch pushed')).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(6000));
    expect(screen.queryByText('Branch pushed')).not.toBeInTheDocument();
  });

  it('does not auto-dismiss a toast that carries an action', () => {
    render(<Harness />);
    act(() => fireEvent.click(screen.getByRole('button', { name: 'Push with action' })));
    expect(screen.getByText('PR #112 opened')).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(10000));
    expect(screen.getByText('PR #112 opened')).toBeInTheDocument();
  });

  it('dismisses an actioned toast once its action is clicked', () => {
    render(<Harness />);
    act(() => fireEvent.click(screen.getByRole('button', { name: 'Push with action' })));
    act(() => fireEvent.click(screen.getByRole('button', { name: 'Open' })));
    expect(screen.queryByText('PR #112 opened')).not.toBeInTheDocument();
  });

  it('queues toasts beyond the stack limit and promotes the oldest queued one on dismiss', () => {
    render(<Harness limit={1} />);
    act(() => fireEvent.click(screen.getByRole('button', { name: 'Push plain' })));
    act(() => fireEvent.click(screen.getByRole('button', { name: 'Push with action' })));

    // Only the first toast is visible -- the second is queued behind the stack limit.
    expect(screen.getByText('Branch pushed')).toBeInTheDocument();
    expect(screen.queryByText('PR #112 opened')).not.toBeInTheDocument();

    act(() => vi.advanceTimersByTime(6000));

    expect(screen.queryByText('Branch pushed')).not.toBeInTheDocument();
    expect(screen.getByText('PR #112 opened')).toBeInTheDocument();
  });
});
