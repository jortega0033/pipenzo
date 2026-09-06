import { useCallback, useState } from 'react';

/**
 * The open/prev/next/close state a screenshot lightbox needs (issue #110). Kept separate from any
 * one screenshot list's shape -- it only ever deals in an index and a count -- so `ScreenshotEvidence`
 * can stay a thin wire-up over it and `ScreenshotLightbox` (built in epic #1, `Screenshot.tsx`)
 * keeps owning Esc/focus-trap/return, which this hook has no reason to duplicate.
 */
export function useScreenshotLightbox(count: number) {
  const [activeIndex, setActiveIndex] = useState<number>();

  const open = useCallback((index: number) => setActiveIndex(index), []);
  const close = useCallback(() => setActiveIndex(undefined), []);
  const prev = useCallback(() => {
    setActiveIndex((current) => (current === undefined || count === 0 ? current : (current + count - 1) % count));
  }, [count]);
  const next = useCallback(() => {
    setActiveIndex((current) => (current === undefined || count === 0 ? current : (current + 1) % count));
  }, [count]);

  return { activeIndex, open, close, prev, next };
}
