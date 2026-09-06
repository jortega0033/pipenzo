import { ICON_PATHS, type IconName } from './icons.js';

export type { IconName } from './icons.js';

const SIZE_PX = {
  xs: 12,
  sm: 14,
  md: 16,
  lg: 20,
} as const;

export type IconSize = keyof typeof SIZE_PX;

/**
 * One entry from the curated Phosphor-regular set in icons.ts, rendered inline (no icon font,
 * no runtime fetch) at one of the canvas's four sizes -- 12 (xs), 14 (sm, the size used inside
 * chips and table rows), 16 (md, the default), 20 (lg, hero states). Fill is currentColor, so
 * the icon always follows the surrounding text/button color.
 *
 * Decorative by default (aria-hidden, matching every icon-plus-label pairing in
 * Foundations.dc.html): pass `label` for the rare case where the icon is the only content
 * conveying meaning -- an icon-only button should still prefer putting its label on the
 * `<button>` itself via aria-label, as ProviderPanel's refresh button and the canvas's own
 * icon-btn examples do, so `label` here is for icons that aren't wrapped in an interactive
 * element at all.
 */
export function Icon({
  name,
  size = 'md',
  label,
  className,
}: {
  name: IconName;
  size?: IconSize;
  label?: string;
  className?: string;
}) {
  const px = SIZE_PX[size];
  return (
    <svg
      className={className}
      width={px}
      height={px}
      viewBox="0 0 256 256"
      fill="currentColor"
      style={{ flexShrink: 0 }}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <path d={ICON_PATHS[name]} />
    </svg>
  );
}
