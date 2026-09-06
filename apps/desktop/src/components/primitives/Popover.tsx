import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from 'react';

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

const GAP = 8;
const VIEWPORT_MARGIN = 8;

export type PopoverAlign = 'start' | 'end';

/**
 * The one floating layer under every menu and palette, from Foundations.dc.html's "Popovers"
 * section: same surface and shadow as .dialog (.pop), but it hangs off the control that opened
 * it instead of covering the screen -- so there is no darkening scrim, only a transparent
 * outside-click catcher (the canvas's own note on .scrim.clear: "the scrim there exists only to
 * catch an outside click, not to darken anything"). CommandPalette (#33) and WorkspaceSwitcher
 * (#34) build their panels on top of this shell rather than reimplementing positioning, focus
 * handling and dismissal each time.
 *
 * Positioning is measured against `anchorRef` after mount (useLayoutEffect, before paint) and
 * recomputed on window resize/scroll -- `align` picks which edge of the anchor the popover
 * starts flush with, and collision detection flips horizontally (right-aligned instead of
 * left-aligned) or vertically (above the anchor instead of below) whenever the naive placement
 * would run past the viewport edge, matching the "positioning + collision" scope in ticket #32.
 */
export function Popover({
  open,
  onClose,
  anchorRef,
  title,
  footer,
  width,
  align = 'start',
  className,
  children,
  'aria-label': ariaLabel,
}: {
  open: boolean;
  onClose: () => void;
  anchorRef: RefObject<HTMLElement | null>;
  title?: string;
  footer?: ReactNode;
  width?: CSSProperties['width'];
  align?: PopoverAlign;
  className?: string;
  children?: ReactNode;
  'aria-label'?: string;
}) {
  const popRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);

  const reposition = () => {
    const popEl = popRef.current;
    if (!popEl) return;

    // A popover is always meant to hang off a real anchor in practice; falling back to a
    // zero-size rect at the viewport origin when the ref isn't attached yet (or in a test that
    // doesn't render one) still produces a valid, visible position instead of leaving the
    // popover permanently hidden waiting for a measurement that will never come.
    const anchorRect = anchorRef.current?.getBoundingClientRect() ?? {
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      width: 0,
      height: 0,
    };
    const popRect = popEl.getBoundingClientRect();

    let left = align === 'end' ? anchorRect.right - popRect.width : anchorRect.left;
    if (left + popRect.width > window.innerWidth - VIEWPORT_MARGIN) {
      left = anchorRect.right - popRect.width;
    }
    left = Math.max(VIEWPORT_MARGIN, left);

    let top = anchorRect.bottom + GAP;
    const fitsBelow = top + popRect.height <= window.innerHeight - VIEWPORT_MARGIN;
    const fitsAbove = anchorRect.top - GAP - popRect.height >= VIEWPORT_MARGIN;
    if (!fitsBelow && fitsAbove) {
      top = anchorRect.top - GAP - popRect.height;
    }
    top = Math.max(VIEWPORT_MARGIN, top);

    setPosition({ top, left });
  };

  // Measure and place on open, and keep it pinned to the anchor across resize/scroll.
  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    reposition();
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, align]);

  // Focus in on open (first focusable element, or the popover itself), back to the trigger on
  // close -- same contract as Dialog.
  useEffect(() => {
    if (!open) return;
    previouslyFocused.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const popEl = popRef.current;
    const firstFocusable = popEl?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
    (firstFocusable ?? popEl)?.focus();

    return () => {
      previouslyFocused.current?.focus();
    };
  }, [open]);

  // Esc closes; Tab/Shift+Tab wrap within the popover's own focusable elements.
  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;

      const popEl = popRef.current;
      if (!popEl) return;
      const focusable = Array.from(popEl.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
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
  }, [open, onClose]);

  if (!open) return null;

  const style: CSSProperties = {
    position: 'fixed',
    // Placed off-screen until the first measurement lands, rather than at 0,0 where it would
    // flash in the top-left corner for a frame.
    top: position?.top ?? -9999,
    left: position?.left ?? -9999,
    visibility: position ? 'visible' : 'hidden',
    ...(width !== undefined ? { width } : undefined),
  };

  return (
    <div
      className="scrim clear"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={popRef}
        className={className ? `pop ${className}` : 'pop'}
        style={style}
        role="dialog"
        aria-label={ariaLabel}
        aria-labelledby={title ? titleId : undefined}
        tabIndex={-1}
      >
        {title && (
          <span className="pop-title" id={titleId}>
            {title}
          </span>
        )}
        {children}
        {footer && <div className="pop-foot">{footer}</div>}
      </div>
    </div>
  );
}
