import type { ReactNode } from 'react';
import {
  ScreenshotLightbox,
  ScreenshotProvenance,
  Shots,
  ScreenshotThumb,
} from '../components/primitives/Screenshot.js';
import { useScreenshotLightbox } from './use-screenshot-lightbox.js';

export interface RailScreenshot {
  readonly label: ReactNode;
  readonly refLabel: ReactNode;
  readonly src?: string;
  /** The lightbox's `.lb-title` once this shot is open, e.g. `"Before — MCP servers panel"`.
   * Defaults to `label` when omitted. */
  readonly lightboxTitle?: ReactNode;
  /** The lightbox's `.lb-sub` -- the header restating provenance issue #110 calls for, e.g.
   * `"main · 287a4a6 · 1280×800 · captured 14:06 by the daemon · self-reported, not verified by a
   * human"`. */
  readonly lightboxSub?: ReactNode;
}

/**
 * Screenshot evidence, thumbnails plus lightbox (issue #110): a `Shots` row of `ScreenshotThumb`s
 * that open a `ScreenshotLightbox` on click, with Previous/Next cycling through the set, Close,
 * Esc, and focus return -- all of which `ScreenshotLightbox` (epic #1, `Screenshot.tsx`) already
 * implements; this component is the state wiring the canvas's static artboard has no way to show:
 * which shot is active, and what its header restates about where it came from.
 *
 * Previously inlined into `RailPanel` (issue #109) as a bare thumbnail row with an
 * `onOpenScreenshot` callback the caller had to wire into a lightbox of its own; extended here
 * into a self-contained piece so the rail never has to know a lightbox exists.
 */
export function ScreenshotEvidence({
  screenshots,
  provenance,
}: {
  screenshots: readonly RailScreenshot[];
  provenance?: ReactNode;
}) {
  const lightbox = useScreenshotLightbox(screenshots.length);
  const active = lightbox.activeIndex !== undefined ? screenshots[lightbox.activeIndex] : undefined;

  return (
    <>
      <Shots>
        {screenshots.map((shot, index) => (
          <ScreenshotThumb
            key={index}
            label={shot.label}
            refLabel={shot.refLabel}
            src={shot.src}
            onOpen={() => lightbox.open(index)}
          />
        ))}
      </Shots>
      {provenance && <ScreenshotProvenance>{provenance}</ScreenshotProvenance>}
      {active && (
        <ScreenshotLightbox
          open
          title={active.lightboxTitle ?? active.label}
          sub={active.lightboxSub}
          refLabel={active.refLabel}
          src={active.src}
          onClose={lightbox.close}
          onPrev={screenshots.length > 1 ? lightbox.prev : undefined}
          onNext={screenshots.length > 1 ? lightbox.next : undefined}
        />
      )}
    </>
  );
}
