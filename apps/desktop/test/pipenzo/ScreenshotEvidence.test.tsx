import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ScreenshotEvidence, type RailScreenshot } from '../../src/pipenzo/ScreenshotEvidence.js';

const SHOTS: RailScreenshot[] = [
  {
    label: 'Before',
    refLabel: 'main · 287a4a6',
    lightboxTitle: 'Before — MCP servers panel',
    lightboxSub: 'main · 287a4a6 · 1280×800 · captured 14:06 by the daemon · self-reported, not verified by a human',
  },
  {
    label: 'After',
    refLabel: 'issue-94 · working tree',
    lightboxTitle: 'After — MCP servers panel',
    lightboxSub: 'issue-94 · working tree · 1280×800 · captured 14:07 by the daemon',
  },
];

describe('ScreenshotEvidence', () => {
  it('renders no lightbox until a thumbnail is clicked', () => {
    render(<ScreenshotEvidence screenshots={SHOTS} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('opens the lightbox from a thumbnail, restating provenance in its header', () => {
    render(<ScreenshotEvidence screenshots={SHOTS} />);
    fireEvent.click(screen.getByText('Before').closest('.shot')!);
    expect(screen.getByText('Before — MCP servers panel', { selector: '.lb-title' })).toBeInTheDocument();
    expect(
      screen.getByText(
        'main · 287a4a6 · 1280×800 · captured 14:06 by the daemon · self-reported, not verified by a human',
      ),
    ).toBeInTheDocument();
  });

  it('Next cycles to the next screenshot and restates its own provenance', () => {
    render(<ScreenshotEvidence screenshots={SHOTS} />);
    fireEvent.click(screen.getByText('Before').closest('.shot')!);
    fireEvent.click(screen.getByRole('button', { name: 'Next photo' }));
    expect(screen.getByText('After — MCP servers panel', { selector: '.lb-title' })).toBeInTheDocument();
  });

  it('Previous wraps back around to the last screenshot', () => {
    render(<ScreenshotEvidence screenshots={SHOTS} />);
    fireEvent.click(screen.getByText('Before').closest('.shot')!);
    fireEvent.click(screen.getByRole('button', { name: 'Previous photo' }));
    expect(screen.getByText('After — MCP servers panel', { selector: '.lb-title' })).toBeInTheDocument();
  });

  it('Close dismisses the lightbox and returns focus to the thumbnail that opened it', () => {
    render(<ScreenshotEvidence screenshots={SHOTS} />);
    const thumbnail = screen.getByText('Before').closest('.shot') as HTMLElement;
    thumbnail.focus();
    fireEvent.click(thumbnail);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(thumbnail).toHaveFocus();
  });

  it('Escape closes the lightbox', () => {
    render(<ScreenshotEvidence screenshots={SHOTS} />);
    fireEvent.click(screen.getByText('Before').closest('.shot')!);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('hides prev/next entirely for a single screenshot', () => {
    render(<ScreenshotEvidence screenshots={[SHOTS[0]!]} />);
    fireEvent.click(screen.getByText('Before').closest('.shot')!);
    expect(screen.queryByRole('button', { name: 'Next photo' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Previous photo' })).not.toBeInTheDocument();
  });

  it('falls back to the plain label as the lightbox title when no lightboxTitle is given', () => {
    render(<ScreenshotEvidence screenshots={[{ label: 'Plain', refLabel: 'main · abc123' }]} />);
    fireEvent.click(screen.getByText('Plain').closest('.shot')!);
    expect(screen.getByText('Plain', { selector: '.lb-title' })).toBeInTheDocument();
  });

  it('renders the shared provenance line under the thumbnails', () => {
    render(<ScreenshotEvidence screenshots={SHOTS} provenance="Captured by the daemon with Playwright" />);
    expect(screen.getByText('Captured by the daemon with Playwright')).toBeInTheDocument();
  });
});
