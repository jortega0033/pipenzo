import { useEffect, useId, useRef, useState } from 'react';
import lockup from '../assets/pipenzo/brand/pipenzo-lockup-horizontal-dark.svg';
import { REPO_URL } from '../content.js';

/** In page order: the boundary section sits directly under the pipeline. */
const LINKS = [
  { label: 'Pipeline', href: '#how-it-works' },
  { label: 'Boundary', href: '#boundary' },
  { label: 'Small PRs', href: '#small-prs' },
  { label: 'Review', href: '#review' },
  { label: 'Status', href: '#status' },
] as const;

/**
 * Sticky, solid (no blur) top bar. At md and up the section links sit inline. Below md they move
 * into a disclosure menu behind a toggle button, so small screens keep the same anchors. The repo
 * link never hides; under 360px it collapses to its icon (with an accessible name) to make room for
 * the toggle.
 */
export function SiteNav() {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const toggleRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        toggleRef.current?.focus();
      }
    };
    const onResize = () => {
      if (window.matchMedia('(min-width: 48rem)').matches) setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
    };
  }, [open]);

  return (
    <header className="sticky top-0 z-40 border-b border-border bg-bg">
      <nav aria-label="Primary" className="mx-auto w-full max-w-6xl">
        <div className="flex h-16 items-center justify-between gap-3 px-6 md:gap-6">
          <a href="#top" className="shrink-0 rounded-sm">
            <img src={lockup} alt="Pipenzo" width={196} height={48} className="h-9 w-auto" />
          </a>
          <ul className="hidden items-center gap-1 md:flex">
            {LINKS.map((link) => (
              <li key={link.href}>
                <a
                  href={link.href}
                  className="rounded-full px-3 py-1.5 text-sm text-text-soft transition-colors hover:bg-surface-2 hover:text-text"
                >
                  {link.label}
                </a>
              </li>
            ))}
          </ul>
          <div className="flex shrink-0 items-center gap-2">
            <a
              href={REPO_URL}
              className="inline-flex shrink-0 items-center gap-2 rounded-full bg-surface-3 px-3 py-2 text-sm font-semibold text-text transition hover:bg-surface-4 min-[360px]:px-4"
            >
              <GitHubMark className="h-4 w-4" />
              <span className="max-[359px]:sr-only">GitHub</span>
            </a>
            <button
              ref={toggleRef}
              type="button"
              aria-expanded={open}
              aria-controls={menuId}
              onClick={() => setOpen((value) => !value)}
              className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-surface-4 text-text transition hover:border-text-faint hover:bg-surface-2 md:hidden"
            >
              <span className="sr-only">Sections</span>
              <svg
                viewBox="0 0 20 20"
                className="h-5 w-5"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.8}
                strokeLinecap="round"
                aria-hidden="true"
              >
                {open ? (
                  <path d="M5 5l10 10M15 5L5 15" />
                ) : (
                  <path d="M3.5 6h13M3.5 10h13M3.5 14h13" />
                )}
              </svg>
            </button>
          </div>
        </div>
        <div id={menuId} hidden={!open} className="border-t border-border px-6 pb-4 pt-2 md:hidden">
          <ul className="grid gap-1">
            {LINKS.map((link) => (
              <li key={link.href}>
                <a
                  href={link.href}
                  onClick={() => setOpen(false)}
                  className="flex min-h-11 items-center rounded-pipenzo px-3 text-base text-text-soft transition-colors hover:bg-surface-2 hover:text-text"
                >
                  {link.label}
                </a>
              </li>
            ))}
          </ul>
        </div>
      </nav>
    </header>
  );
}

export function GitHubMark({ className = '' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}
