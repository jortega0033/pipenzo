import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Button } from '../../src/components/primitives/Button.js';

describe('Button', () => {
  it('renders as a real <button type="button"> by default, not a styled div', () => {
    render(<Button>Push branch</Button>);
    const btn = screen.getByRole('button', { name: 'Push branch' });
    expect(btn.tagName).toBe('BUTTON');
    expect(btn).toHaveAttribute('type', 'button');
    expect(btn.className).toBe('btn');
  });

  it.each([
    ['primary', 'btn primary'],
    ['ghost', 'btn ghost'],
    ['danger', 'btn danger'],
  ] as const)('applies the %s variant class', (variant, expectedClass) => {
    render(
      <Button variant={variant} data-testid="b">
        Go
      </Button>,
    );
    expect(screen.getByTestId('b').className).toBe(expectedClass);
  });

  it.each([
    ['sm', 'btn sm'],
    ['lg', 'btn lg'],
  ] as const)('applies the %s size class', (size, expectedClass) => {
    render(
      <Button size={size} data-testid="b">
        Go
      </Button>,
    );
    expect(screen.getByTestId('b').className).toBe(expectedClass);
  });

  it('renders a leading icon before the label when one is given', () => {
    render(<Button icon="plus">New from idea</Button>);
    const btn = screen.getByRole('button', { name: 'New from idea' });
    expect(btn.querySelector('svg')).toBeInTheDocument();
  });

  it('fires onClick on a resting button', () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Push branch</Button>);
    fireEvent.click(screen.getByRole('button', { name: 'Push branch' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('is disabled via the disabled attribute', () => {
    render(<Button disabled>Resume</Button>);
    expect(screen.getByRole('button', { name: 'Resume' })).toBeDisabled();
  });

  describe('pending', () => {
    it('sets aria-busy, swaps the icon for a spinner, and keeps the button focusable rather than DOM-disabled', () => {
      render(
        <Button pending variant="primary" icon="git-pull-request">
          Starting…
        </Button>,
      );
      const btn = screen.getByRole('button', { name: 'Starting…' });
      expect(btn).toHaveAttribute('aria-busy', 'true');
      expect(btn).not.toBeDisabled();
      expect(btn.className).toBe('btn primary pending');
      expect(btn.querySelector('svg')?.getAttribute('class')).toBe('icon spin');
    });

    it('never collapses to a bare spinner -- the label passed as children is still rendered', () => {
      render(<Button pending>Pushing…</Button>);
      expect(screen.getByText('Pushing…')).toBeInTheDocument();
    });

    it('ignores clicks while pending instead of firing the handler', () => {
      const onClick = vi.fn();
      render(
        <Button pending onClick={onClick}>
          Pushing…
        </Button>,
      );
      fireEvent.click(screen.getByRole('button', { name: 'Pushing…' }));
      expect(onClick).not.toHaveBeenCalled();
    });
  });
});
