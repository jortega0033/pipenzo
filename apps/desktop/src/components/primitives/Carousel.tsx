import { useEffect, useRef, useState, type ReactNode } from 'react';
import { IconButton } from './IconButton.js';
import { Icon, type IconName } from './Icon.js';

// 300px slide + the carousel's own 8px gap -- one "page" of horizontal scroll, and the unit the
// arrow controls advance by.
const SLIDE_WIDTH = 300;
const SLIDE_GAP = 8;
const STEP = SLIDE_WIDTH + SLIDE_GAP;

/**
 * The carousel from Foundations.dc.html's own closing reference-sheet section: Carbon's pattern
 * of native overflow scrolling (`scroll-snap-type: x mandatory`, a hidden scrollbar) with arrow
 * buttons that page by one slide and dots that read the current scroll position -- never a
 * navigation control of their own, so there's no click handler on them to wire up.
 *
 * Low priority per the canvas's own note: "Reference sheet only; no product screen needs one
 * today." Built anyway, matching every other primitive in this batch, since a future screen may
 * still reach for it.
 *
 * The static artboard has no scroll position to read, so the active-dot tracking here is this
 * ticket's own addition: a plain scroll listener maps `scrollLeft` back to the nearest slide
 * index (slides are a fixed 300px + 8px gap, so this is exact, not an estimate) rather than
 * anything heavier like an IntersectionObserver per slide. `slides` takes rendered `Slide`
 * elements directly (not raw `children`) so the dot count and active index have a real length to
 * work from.
 */
export function Carousel({ title, slides }: { title: ReactNode; slides: ReactNode[] }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const onScroll = () => {
      const index = Math.round(el.scrollLeft / STEP);
      setActive(Math.max(0, Math.min(slides.length - 1, index)));
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [slides.length]);

  const page = (direction: 1 | -1) => {
    scrollRef.current?.scrollBy({ left: direction * STEP, behavior: 'smooth' });
  };

  return (
    <div className="carousel-wrap">
      <div className="carousel-head">
        <span className="carousel-title">{title}</span>
        <div className="carousel-nav">
          <IconButton icon="caret-left" aria-label="Previous slide" onClick={() => page(-1)} />
          <IconButton icon="caret-right" aria-label="Next slide" onClick={() => page(1)} />
        </div>
      </div>
      <div className="carousel" ref={scrollRef}>
        {slides}
      </div>
      <div className="dots">
        {slides.map((_, index) => (
          <span key={index} className={index === active ? 'dot on' : 'dot'} />
        ))}
      </div>
    </div>
  );
}

/** One `.slide`: a mono top line (icon + a short state phrase, e.g. "#105 · merged"), a title,
 * and a meta row (a mono left part, a plain right part -- the canvas's own example pairs a diff
 * stat with a weekday). */
export function Slide({
  icon,
  top,
  title,
  metaLeft,
  metaRight,
}: {
  icon: IconName;
  /** The text after the icon on `.slide-top`, e.g. `"#105 · merged"`. */
  top: ReactNode;
  title: ReactNode;
  metaLeft: ReactNode;
  metaRight: ReactNode;
}) {
  return (
    <div className="slide">
      <span className="slide-top">
        <Icon name={icon} size="sm" />
        {top}
      </span>
      <span className="slide-title">{title}</span>
      <span className="slide-meta">
        <span className="mono">{metaLeft}</span>
        <span>{metaRight}</span>
      </span>
    </div>
  );
}
