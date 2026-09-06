import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  ScreenshotLightbox,
  ScreenshotProvenance,
  ScreenshotThumb,
  Shots,
} from '../../src/components/primitives/Screenshot.js';

describe('ScreenshotThumb', () => {
  it('renders the caption and a placeholder illustration when no src is given', () => {
    const { container } = render(<ScreenshotThumb label="Before" refLabel="main · 287a4a6" />);
    expect(screen.getByText('Before')).toBeInTheDocument();
    expect(screen.getByText('main · 287a4a6')).toBeInTheDocument();
    expect(container.querySelectorAll('.ph').length).toBeGreaterThan(0);
    expect(container.querySelector('img')).not.toBeInTheDocument();
  });

  it('renders a real image when src is given, no placeholder rects', () => {
    const { container } = render(
      <ScreenshotThumb label="After" refLabel="issue-94" src="blob:shot.png" />,
    );
    const img = container.querySelector('img');
    expect(img).toHaveAttribute('src', 'blob:shot.png');
    expect(container.querySelectorAll('.ph')).toHaveLength(0);
  });

  it('is clickable (role=button, tabIndex 0) at the default size, and calls onOpen on click and Enter/Space', () => {
    const onOpen = vi.fn();
    render(<ScreenshotThumb label="Before" refLabel="ref" onOpen={onOpen} />);
    const thumb = screen.getByRole('button');
    expect(thumb).toHaveAttribute('tabIndex', '0');
    fireEvent.click(thumb);
    fireEvent.keyDown(thumb, { key: 'Enter' });
    fireEvent.keyDown(thumb, { key: ' ' });
    fireEvent.keyDown(thumb, { key: 'a' });
    expect(onOpen).toHaveBeenCalledTimes(3);
  });

  it('renders the large variant with no button role and no click handler', () => {
    const onOpen = vi.fn();
    const { container } = render(
      <ScreenshotThumb large label="After · MCP servers panel" refLabel="issue-94 · 1280×800 · 14:06" onOpen={onOpen} />,
    );
    const shot = container.querySelector('.shot')!;
    expect(shot.className).toBe('shot lg');
    expect(shot).not.toHaveAttribute('role');
    fireEvent.click(shot);
    expect(onOpen).not.toHaveBeenCalled();
  });
});

describe('Shots/ScreenshotProvenance', () => {
  it('wraps thumbnails in a .shots row', () => {
    const { container } = render(
      <Shots>
        <ScreenshotThumb label="Before" refLabel="a" />
        <ScreenshotThumb label="After" refLabel="b" />
      </Shots>,
    );
    expect(container.querySelector('.shots')).toBeInTheDocument();
    expect(container.querySelectorAll('.shot')).toHaveLength(2);
  });

  it('renders the provenance line', () => {
    render(
      <ScreenshotProvenance>
        Captured by the daemon with the repo&apos;s Playwright · 1280×800 · against base{' '}
        <span className="mono">287a4a6</span>
      </ScreenshotProvenance>,
    );
    expect(screen.getByText(/Captured by the daemon/)).toBeInTheDocument();
  });
});

describe('ScreenshotLightbox', () => {
  it('renders nothing when closed', () => {
    const { container } = render(
      <ScreenshotLightbox open={false} title="Before" refLabel="main · 287a4a6" onClose={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders title, sub and the expanded shot when open', () => {
    render(
      <ScreenshotLightbox
        open
        title="Before — MCP servers panel"
        sub="main · 287a4a6 · 1280×800 · captured 14:06 by the daemon"
        refLabel="main · 287a4a6"
        onClose={vi.fn()}
      />,
    );
    expect(screen.getAllByText('Before — MCP servers panel').length).toBeGreaterThan(0);
    expect(screen.getByText(/captured 14:06 by the daemon/)).toBeInTheDocument();
  });

  it('omits prev/next controls when their handlers are not given, always renders close', () => {
    render(<ScreenshotLightbox open title="Before" refLabel="ref" onClose={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Previous photo' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Next photo' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
  });

  it('calls onClose on the Close button, on Escape, and on a scrim click but not a click inside the lightbox', () => {
    const onClose = vi.fn();
    const { container } = render(
      <ScreenshotLightbox open title="Before" refLabel="ref" onClose={onClose} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);

    fireEvent.click(container.querySelector('.lightbox')!);
    expect(onClose).toHaveBeenCalledTimes(2);

    fireEvent.click(container.querySelector('.scrim')!);
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('calls onPrev/onNext from their buttons and from ArrowLeft/ArrowRight', () => {
    const onPrev = vi.fn();
    const onNext = vi.fn();
    render(
      <ScreenshotLightbox
        open
        title="Before"
        refLabel="ref"
        onClose={vi.fn()}
        onPrev={onPrev}
        onNext={onNext}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Previous photo' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next photo' }));
    fireEvent.keyDown(document, { key: 'ArrowLeft' });
    fireEvent.keyDown(document, { key: 'ArrowRight' });
    expect(onPrev).toHaveBeenCalledTimes(2);
    expect(onNext).toHaveBeenCalledTimes(2);
  });

  it('moves focus into the lightbox on open and returns it to the trigger on close', () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>trigger</button>
          <ScreenshotLightbox
            open={open}
            title="Before"
            refLabel="ref"
            onClose={() => setOpen(false)}
          />
        </>
      );
    }
    render(<Harness />);
    const trigger = screen.getByText('trigger');
    trigger.focus();
    expect(document.activeElement).toBe(trigger);
    fireEvent.click(trigger);
    expect(document.activeElement).not.toBe(trigger);
    expect(document.activeElement?.closest('.lightbox')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.activeElement).toBe(trigger);
  });
});
