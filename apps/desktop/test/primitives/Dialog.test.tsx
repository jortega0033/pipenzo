import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Dialog } from '../../src/components/primitives/Dialog.js';

function Trigger({ scrim }: { scrim?: 'default' | 'top' | 'clear' }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button onClick={() => setOpen(true)}>Open dialog</button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="New from idea"
        subtitle="Describe the problem in your own words."
        scrim={scrim}
        actions={
          <>
            <button>Keep chatting</button>
            <button className="btn primary">Create issue</button>
          </>
        }
      >
        <input aria-label="What's the problem?" />
      </Dialog>
    </div>
  );
}

describe('Dialog', () => {
  it('renders nothing when closed', () => {
    render(<Dialog open={false} onClose={vi.fn()} title="Hidden" />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('renders title, subtitle and actions with the right roles/labelling when open', () => {
    render(<Trigger />);
    fireEvent.click(screen.getByRole('button', { name: 'Open dialog' }));
    const dialog = screen.getByRole('dialog', { name: 'New from idea' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByText('Describe the problem in your own words.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create issue' })).toBeInTheDocument();
  });

  it('defaults to the "default" scrim class and applies top/clear variants', () => {
    const { container, rerender } = render(
      <Dialog open onClose={vi.fn()} title="T">
        content
      </Dialog>,
    );
    expect(container.querySelector('.scrim')?.className).toBe('scrim');

    rerender(
      <Dialog open onClose={vi.fn()} title="T" scrim="top">
        content
      </Dialog>,
    );
    expect(container.querySelector('.scrim')?.className).toBe('scrim top');

    rerender(
      <Dialog open onClose={vi.fn()} title="T" scrim="clear">
        content
      </Dialog>,
    );
    expect(container.querySelector('.scrim')?.className).toBe('scrim clear');
  });

  it('moves focus into the dialog on open and back to the trigger on close', () => {
    render(<Trigger />);
    const openButton = screen.getByRole('button', { name: 'Open dialog' });
    openButton.focus();
    fireEvent.click(openButton);

    expect(document.activeElement).toBe(screen.getByLabelText("What's the problem?"));

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(document.activeElement).toBe(openButton);
  });

  it('calls onClose on Escape', () => {
    const onClose = vi.fn();
    render(
      <Dialog open onClose={onClose} title="T">
        content
      </Dialog>,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes when the scrim itself is clicked, not when the dialog content is clicked', () => {
    const onClose = vi.fn();
    const { container } = render(
      <Dialog open onClose={onClose} title="T">
        <button>Inside</button>
      </Dialog>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Inside' }));
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(container.querySelector('.scrim')!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('wraps Tab from the last focusable element back to the first', () => {
    render(
      <Dialog open onClose={vi.fn()} title="T" actions={<button>Last</button>}>
        <button>First</button>
      </Dialog>,
    );
    const last = screen.getByRole('button', { name: 'Last' });
    last.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'First' }));
  });

  it('wraps Shift+Tab from the first focusable element back to the last', () => {
    render(
      <Dialog open onClose={vi.fn()} title="T" actions={<button>Last</button>}>
        <button>First</button>
      </Dialog>,
    );
    const first = screen.getByRole('button', { name: 'First' });
    first.focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Last' }));
  });
});
