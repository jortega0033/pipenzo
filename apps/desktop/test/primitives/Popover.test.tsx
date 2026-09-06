import { fireEvent, render, screen } from '@testing-library/react';
import { useRef, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Popover } from '../../src/components/primitives/Popover.js';

function Trigger({ align }: { align?: 'start' | 'end' }) {
  const anchorRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button ref={anchorRef} onClick={() => setOpen(true)}>
        Open popover
      </button>
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={anchorRef}
        title="Connected repos · 3"
        align={align}
        footer={<span>Adding or removing a repo is Settings&apos; job.</span>}
      >
        <button>jortega0033/agentdock</button>
      </Popover>
    </div>
  );
}

describe('Popover', () => {
  it('renders nothing when closed', () => {
    render(<Popover open={false} onClose={vi.fn()} anchorRef={{ current: null }} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('renders the title, children and footer when open', () => {
    render(<Trigger />);
    fireEvent.click(screen.getByRole('button', { name: 'Open popover' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Connected repos · 3')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'jortega0033/agentdock' })).toBeInTheDocument();
    expect(screen.getByText(/Settings' job/)).toBeInTheDocument();
  });

  it('moves focus into the popover on open and back to the trigger on close', () => {
    render(<Trigger />);
    const openButton = screen.getByRole('button', { name: 'Open popover' });
    openButton.focus();
    fireEvent.click(openButton);

    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'jortega0033/agentdock' }),
    );

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(document.activeElement).toBe(openButton);
  });

  it('calls onClose on Escape', () => {
    const onClose = vi.fn();
    render(
      <Popover open onClose={onClose} anchorRef={{ current: null }} title="T">
        <button>Item</button>
      </Popover>,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on an outside click but not a click inside the popover', () => {
    const onClose = vi.fn();
    const { container } = render(
      <Popover open onClose={onClose} anchorRef={{ current: null }} title="T">
        <button>Inside</button>
      </Popover>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Inside' }));
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(container.querySelector('.scrim')!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('wraps Tab from the last focusable element back to the first', () => {
    render(
      <Popover open onClose={vi.fn()} anchorRef={{ current: null }} title="T">
        <button>First</button>
        <button>Last</button>
      </Popover>,
    );
    const last = screen.getByRole('button', { name: 'Last' });
    last.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'First' }));
  });

  it('applies extra className alongside .pop', () => {
    const { container } = render(
      <Popover
        open
        onClose={vi.fn()}
        anchorRef={{ current: null }}
        className="cmdk-panel"
        title="T"
      >
        content
      </Popover>,
    );
    expect(container.querySelector('.pop.cmdk-panel')).toBeInTheDocument();
  });
});
