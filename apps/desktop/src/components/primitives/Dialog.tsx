import { useEffect, useId, useRef, type CSSProperties, type ReactNode } from 'react';

export type ScrimVariant = 'default' | 'top' | 'clear';

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The dialog + scrim shell from Foundations.dc.html's "Elevation" section (.dialog: surface-3
 * under the standard shadow) and the .scrim rule shared by Main.dc.html/DiffReview.dc.html
 * wherever a dialog actually opens over a screen. Handles what a static artboard can't show:
 * a focus trap (Tab/Shift+Tab cycle within the dialog), Esc to close, and returning focus to
 * whatever triggered the dialog once it closes.
 *
 * `scrim` picks the rendering: `default` (dark, centered, blocks the screen behind it) for a
 * real modal dialog; `top` (aligned to the top with headroom) for something like the ⌘K
 * palette, which should leave the board readable behind it; `clear` (transparent, click-outside
 * only) for a menu anchored to the control that opened it.
 */
export function Dialog({
  open,
  onClose,
  title,
  subtitle,
  scrim = 'default',
  width,
  actions,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: ReactNode;
  scrim?: ScrimVariant;
  width?: CSSProperties['width'];
  actions?: ReactNode;
  children?: ReactNode;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const subtitleId = useId();

  // Focus in on open (the first focusable element inside, or the dialog itself if it has none),
  // and back out to whatever had focus before the dialog opened once it closes.
  useEffect(() => {
    if (!open) return;
    previouslyFocused.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialogEl = dialogRef.current;
    const firstFocusable = dialogEl?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
    (firstFocusable ?? dialogEl)?.focus();

    return () => {
      previouslyFocused.current?.focus();
    };
  }, [open]);

  // Esc closes; Tab/Shift+Tab wrap within the dialog's own focusable elements instead of
  // escaping to the rest of the page.
  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;

      const dialogEl = dialogRef.current;
      if (!dialogEl) return;
      const focusable = Array.from(dialogEl.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
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

  return (
    <div
      className={scrim === 'default' ? 'scrim' : `scrim ${scrim}`}
      onClick={(event) => {
        // Only the scrim itself dismisses -- a click that bubbled up from inside the dialog
        // must not close it.
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={subtitle ? subtitleId : undefined}
        style={width !== undefined ? { width } : undefined}
        tabIndex={-1}
      >
        <div>
          <div className="dialog-title" id={titleId}>
            {title}
          </div>
          {subtitle && (
            <div className="dialog-sub" id={subtitleId}>
              {subtitle}
            </div>
          )}
        </div>
        {children}
        {actions && <div className="dialog-actions">{actions}</div>}
      </div>
    </div>
  );
}
