import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { Icon } from './Icon.js';
import { IconButton } from './IconButton.js';

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** `.shots` -- the flex row a Before/After (or any) pair of `ScreenshotThumb`s sits in. */
export function Shots({ children }: { children: ReactNode }) {
  return <div className="shots">{children}</div>;
}

/**
 * `.shot` -- one browser-viewport thumbnail from Foundations.dc.html's screenshot-evidence
 * sample: a 16:10 frame with a three-dot/url chrome bar (so it reads as a captured viewport, not
 * a plain card), a caption (bold label, mono ref), and -- on the default, clickable size -- a
 * brightness lift on hover. `large` is the `.shot.lg` expanded rendering the lightbox uses:
 * bigger chrome, `cursor: default`, no hover effect, since it's not clickable once it's already
 * the thing you clicked to see.
 *
 * `src` renders a real captured image; omit it to fall back to the canvas's own placeholder
 * rectangles (a generic "browser panel" illustration) -- useful for a demo/storybook rendering
 * with no real capture to show, the same role Skeleton.tsx's shapes play elsewhere.
 */
export function ScreenshotThumb({
  label,
  refLabel,
  src,
  large = false,
  onOpen,
}: {
  label: ReactNode;
  /** The mono reference under the label, e.g. `"main · 287a4a6"` or `"issue-94 · 1280×800 · 14:06"`. */
  refLabel: ReactNode;
  src?: string;
  large?: boolean;
  onOpen?: () => void;
}) {
  const clickable = !large && !!onOpen;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!clickable) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onOpen?.();
    }
  };

  return (
    <div
      className={large ? 'shot lg' : 'shot'}
      tabIndex={large ? undefined : 0}
      role={clickable ? 'button' : undefined}
      onClick={clickable ? onOpen : undefined}
      onKeyDown={clickable ? onKeyDown : undefined}
    >
      <div className="shot-frame">
        <div className="shot-bar">
          <i />
          <i />
          <i />
          <span className="url" />
        </div>
        <div className="shot-body">{src ? <img src={src} alt="" /> : <ScreenshotPlaceholder />}</div>
      </div>
      <div className="shot-cap">
        <b>{label}</b>
        <span>{refLabel}</span>
      </div>
    </div>
  );
}

/** `.shot-prov` -- the fixed provenance line under a shot pair: who captured it, at what size,
 * against which base commit. */
export function ScreenshotProvenance({ children }: { children: ReactNode }) {
  return (
    <div className="shot-prov">
      <Icon name="camera" size="sm" />
      <span>{children}</span>
    </div>
  );
}

/**
 * The lightbox: expands a `ScreenshotThumb` full-size over a `.scrim`, from DiffReview.dc.html's
 * shot-open state. Static in the canvas (it's just another `sc-if` panel); the interactivity is
 * this ticket's own addition, following the same shape Dialog.tsx already established -- Esc
 * closes, Tab/Shift+Tab wrap inside the lightbox, and focus returns to whatever opened it once it
 * closes.
 *
 * `onPrev`/`onNext` are optional -- omit either (or both) to hide that nav control, e.g. for a
 * single-screenshot evidence set with nothing to page through.
 */
export function ScreenshotLightbox({
  open,
  title,
  sub,
  refLabel,
  src,
  onClose,
  onPrev,
  onNext,
}: {
  open: boolean;
  /** The `.lb-title`, e.g. `"Before — MCP servers panel"`. */
  title: ReactNode;
  /** The `.lb-sub` mono line, e.g. `"main · 287a4a6 · 1280×800 · captured 14:06 by the daemon · self-reported, not verified by a human"`. */
  sub?: ReactNode;
  /** The expanded `.shot.lg`'s own caption ref, e.g. `"issue-94 · 1280×800 · 14:06"`. */
  refLabel: ReactNode;
  src?: string;
  onClose: () => void;
  onPrev?: () => void;
  onNext?: () => void;
}) {
  const lightboxRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    previouslyFocused.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const el = lightboxRef.current;
    const firstFocusable = el?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
    (firstFocusable ?? el)?.focus();

    return () => {
      previouslyFocused.current?.focus();
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent_) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key === 'ArrowLeft' && onPrev) {
        event.preventDefault();
        onPrev();
        return;
      }
      if (event.key === 'ArrowRight' && onNext) {
        event.preventDefault();
        onNext();
        return;
      }
      if (event.key !== 'Tab') return;

      const el = lightboxRef.current;
      if (!el) return;
      const focusable = Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onClose, onPrev, onNext]);

  if (!open) return null;

  return (
    <div
      className="scrim"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div ref={lightboxRef} className="lightbox" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <div className="lb-head">
          <div>
            <div className="lb-title" id={titleId}>
              {title}
            </div>
            {sub && <div className="lb-sub">{sub}</div>}
          </div>
          <div className="lb-nav">
            {onPrev && <IconButton icon="caret-left" aria-label="Previous photo" onClick={onPrev} />}
            {onNext && <IconButton icon="caret-right" aria-label="Next photo" onClick={onNext} />}
            <IconButton icon="x" aria-label="Close" onClick={onClose} />
          </div>
        </div>
        <ScreenshotThumb large label={title} refLabel={refLabel} src={src} />
      </div>
    </div>
  );
}

/** The canvas's own generic "browser panel" placeholder illustration -- a left rail plus three
 * stacked highlighted rows -- ported verbatim (percentages included) from Foundations.dc.html's
 * `.shot-body` sample, used when a `ScreenshotThumb` has no real `src` to show. */
function ScreenshotPlaceholder() {
  return (
    <>
      <div className="ph" style={{ left: 0, top: 0, bottom: 0, width: '22%', background: 'var(--color-surface-3)' }} />
      <div className="ph txt" style={{ left: '4%', top: '8%', width: '12%', height: '6%' }} />
      <div className="ph hi" style={{ left: '4%', top: '22%', width: '14%', height: '8%' }} />
      <div className="ph txt" style={{ left: '4%', top: '38%', width: '10%', height: '5%' }} />
      <div className="ph txt" style={{ left: '28%', top: '8%', width: '30%', height: '7%' }} />
      <div className="ph hi" style={{ left: '28%', top: '24%', width: '66%', height: '14%' }} />
      <div className="ph bad" style={{ left: '31%', top: '29%', width: '2.6%', height: '4.2%', borderRadius: '50%' }} />
      <div className="ph txt" style={{ left: '37%', top: '28.5%', width: '22%', height: '5%' }} />
      <div className="ph hi" style={{ left: '28%', top: '44%', width: '66%', height: '14%' }} />
      <div className="ph acc" style={{ left: '31%', top: '49%', width: '2.6%', height: '4.2%', borderRadius: '50%' }} />
      <div className="ph txt" style={{ left: '37%', top: '48.5%', width: '18%', height: '5%' }} />
      <div className="ph hi" style={{ left: '28%', top: '64%', width: '66%', height: '14%' }} />
      <div className="ph acc" style={{ left: '31%', top: '69%', width: '2.6%', height: '4.2%', borderRadius: '50%' }} />
      <div className="ph txt" style={{ left: '37%', top: '68.5%', width: '26%', height: '5%' }} />
    </>
  );
}

// Local alias -- avoids importing the DOM lib's `KeyboardEvent` under the same name as React's
// `KeyboardEvent<T>` type already imported above for the thumbnail's own key handler.
type KeyboardEvent_ = globalThis.KeyboardEvent;
