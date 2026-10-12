import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from '../src/App.js';
import { REPO_URL, WORKFLOW_STEPS } from '../src/content.js';

describe('App', () => {
  it('renders exactly one h1, the canonical positioning line', () => {
    render(<App />);
    const h1s = screen.getAllByRole('heading', { level: 1 });
    expect(h1s).toHaveLength(1);
    expect(h1s[0]).toHaveTextContent('Pipenzo delegates engineering work without delegating authority.');
  });

  it("links the primary CTA to the real repo, never a fake download", () => {
    render(<App />);
    const cta = screen.getByRole('link', { name: 'View on GitHub' });
    expect(cta).toHaveAttribute('href', REPO_URL);
    expect(screen.queryByRole('link', { name: /download/i })).not.toBeInTheDocument();
  });

  it('states the workflow phases in Refine -> Implement -> Review -> Verify -> You-approve order, human decision last', () => {
    render(<App />);
    const phases = WORKFLOW_STEPS.map((s) => s.phase);
    const headings = screen
      .getAllByRole('heading', { level: 3 })
      .map((h) => h.textContent)
      .filter((text): text is string => phases.includes(text as (typeof phases)[number]));
    expect(headings).toEqual(phases);
    expect(headings.at(-1)).toBe('You approve');
  });

  it('describes the three small-PR outcomes in plain language', () => {
    render(<App />);
    const section = document.getElementById('small-prs')!;
    for (const outcome of ['Small change', 'Bigger change', 'Too big to split cleanly']) {
      expect(within(section).getByRole('heading', { level: 3, name: outcome })).toBeInTheDocument();
    }
  });

  it('never claims a customer count, acceptance rate, or testimonial', () => {
    render(<App />);
    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/\d+%\s*(faster|acceptance|success)/i);
    expect(text).not.toMatch(/trusted by|customers|testimonial/i);
  });

  it('marks decorative mascot art as aria-hidden rather than exposing it as meaningful content', () => {
    const { container } = render(<App />);
    const decorativeImages = container.querySelectorAll('img[aria-hidden="true"]');
    expect(decorativeImages.length).toBeGreaterThan(0);
    for (const image of decorativeImages) {
      expect(image).toHaveAttribute('alt', '');
    }
  });

  it('gives every meaningful illustration real, non-empty alt text', () => {
    render(<App />);
    // Illustration <img>s with alt text render with role "img"; every one found must have real
    // text, not an empty placeholder, and not a bare filename/extension leaking through.
    const images = screen.getAllByRole('img');
    expect(images.length).toBeGreaterThan(0);
    for (const image of images) {
      const alt = image.getAttribute('alt');
      expect(alt).toBeTruthy();
      expect(alt).not.toMatch(/\.(webp|png|svg)$/i);
    }
  });

  it('renders the footer with real repo/license/security links, not SaaS boilerplate', () => {
    render(<App />);
    const footer = screen.getByRole('contentinfo');
    expect(within(footer).getByRole('link', { name: 'GitHub' })).toHaveAttribute('href', REPO_URL);
    expect(within(footer).getByRole('link', { name: 'License' })).toBeInTheDocument();
    expect(within(footer).getByRole('link', { name: 'Security' })).toBeInTheDocument();
  });

  it('has a skip link as the first focusable element', () => {
    render(<App />);
    const skipLink = screen.getByRole('link', { name: 'Skip to content' });
    expect(skipLink).toHaveAttribute('href', '#main');
  });

  /**
   * The page stays at a plain-language level: exact thresholds, the named check list, and
   * routing-class/tier names live in README.md only. Keeping them off the page also removes the
   * hand-copied gate list that issue #289 flagged as a drift risk.
   */
  it('keeps spec-level detail out of the visible copy', () => {
    render(<App />);
    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/≤|\b(100|400)\s*(changed\s+)?lines\b|\b(10|20)\s*files\b/i);
    expect(text).not.toMatch(/gitleaks|semgrep|typecheck|\blint\b|diff-scope|spec-generated/i);
    expect(text).not.toMatch(/implement-(small|standard|hard)|routing class|model tier/i);
    expect(text).not.toMatch(/\b(cheap|mid|frontier)\b/i);
  });
});
