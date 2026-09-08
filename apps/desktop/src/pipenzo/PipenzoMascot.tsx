import inspectorReview from '../../assets/pipenzo/mascot/detailed/pipenzo-inspector-review.webp';
import readyForApproval from '../../assets/pipenzo/illustrations/pipenzo-ready-for-approval-1200x800.webp';

export type PipenzoMascotRole = 'engineer' | 'commander' | 'recon' | 'inspector' | 'auditor' | 'ready';
export type PipenzoMascotPose =
  | 'neutral'
  | 'working'
  | 'focused'
  | 'refuse'
  | 'review-complete'
  | 'ready'
  | 'waiting';
export type PipenzoMascotSize = 'mini' | 'sm' | 'md' | 'lg' | 'hero';

// Target long edge in CSS pixels; the other edge is derived from the source asset's own aspect
// ratio (illustrations/mascot art all ship at different natural aspect ratios -- see ASSET below
// -- so this can't be a single fixed width/height pair the way an icon's square grid can).
const SIZE_PX: Record<PipenzoMascotSize, number> = {
  mini: 32,
  sm: 64,
  md: 128,
  lg: 320,
  hero: 640,
};

// Mirrors the .icon/.icon-sm/.icon-lg convention in primitives/Icon.tsx: applied alongside the
// explicit width/height below so pipenzo-theme.css has a size hook to target if a screen ever
// needs to override spacing/margin around one size but not another.
const SIZE_CLASS: Record<PipenzoMascotSize, string> = {
  mini: 'pipenzo-mascot-mini',
  sm: 'pipenzo-mascot-sm',
  md: 'pipenzo-mascot-md',
  lg: 'pipenzo-mascot-lg',
  hero: 'pipenzo-mascot-hero',
};

interface MascotAsset {
  readonly src: string;
  readonly width: number;
  readonly height: number;
}

/**
 * The single role -> pose -> asset mapping this whole component exists to own (see #244). Every
 * entry here is a real, approved file from the pack #239 checked in -- nothing here is allowed to
 * point at a redrawn/regenerated character. Deliberately not a dense role x pose matrix, and
 * deliberately not pre-populated for a screen that doesn't exist yet: only the two combinations
 * actually wired into a real component today are listed (RailPanel's phase badge, DiffReviewHead's
 * ready-for-approval badge), and ROLE_POSE_ASSETS is read-only at the type level so a combination
 * that isn't here throws in getMascotAsset() below rather than silently falling back to something
 * wrong. Add an entry here in the same PR that wires its next real call site -- e.g. #244's other
 * suggested locations (first-run empty state, oversized-ticket refusal, review-complete summary)
 * once the underlying screen they'd attach to actually exists; see this component's own PR for why
 * those weren't invented speculatively.
 *
 * "ready" is both a role (the approval-boundary loadout) and a pose (the specific waiting
 * behavior); there's no dedicated Field Engineer "ready" character art distinct from "neutral" in
 * the approved pack, so this state is represented by the composed approval-boundary illustration
 * instead of a character-only asset.
 */
const ROLE_POSE_ASSETS: Partial<Record<PipenzoMascotRole, Partial<Record<PipenzoMascotPose, MascotAsset>>>> = {
  inspector: {
    focused: { src: inspectorReview, width: 1536, height: 1536 },
  },
  ready: {
    waiting: { src: readyForApproval, width: 1200, height: 800 },
  },
};

function getMascotAsset(role: PipenzoMascotRole, pose: PipenzoMascotPose): MascotAsset {
  const asset = ROLE_POSE_ASSETS[role]?.[pose];
  if (!asset) {
    const valid = Object.entries(ROLE_POSE_ASSETS)
      .flatMap(([r, poses]) => Object.keys(poses ?? {}).map((p) => `${r}/${p}`))
      .sort();
    throw new Error(
      `PipenzoMascot: no approved asset for role="${role}" pose="${pose}". Valid combinations: ${valid.join(', ')}.`,
    );
  }
  return asset;
}

export interface PipenzoMascotProps {
  readonly role: PipenzoMascotRole;
  readonly pose: PipenzoMascotPose;
  /** @default 'md' */
  readonly size?: PipenzoMascotSize;
  readonly className?: string;
  /**
   * Meaningful alt text. Omit for decorative use (the common case: mascot art is narrative
   * support, not the primary evidence on a screen) -- an omitted `alt` renders `aria-hidden` with
   * an empty `alt=""` rather than letting the filename or a generic label leak to screen readers.
   */
  readonly alt?: string;
  /** @default true (below-the-fold placements should leave this at its default) */
  readonly eager?: boolean;
}

/**
 * The one place role/pose/size resolve to an approved Pipenzo asset file (see #244's own mandate:
 * "one central asset-mapping primitive", not raw imports scattered across screens). Static PNG/
 * WebP only -- no animation, so there's nothing for `prefers-reduced-motion` to disable yet; static
 * art is an explicitly valid v1 per the ticket.
 */
export function PipenzoMascot({ role, pose, size = 'md', className, alt, eager }: PipenzoMascotProps) {
  const asset = getMascotAsset(role, pose);
  const targetLongEdge = SIZE_PX[size];
  const scale = targetLongEdge / Math.max(asset.width, asset.height);
  const width = Math.round(asset.width * scale);
  const height = Math.round(asset.height * scale);
  const decorative = alt === undefined;

  return (
    <img
      className={[SIZE_CLASS[size], className].filter(Boolean).join(' ')}
      src={asset.src}
      width={width}
      height={height}
      alt={decorative ? '' : alt}
      aria-hidden={decorative ? true : undefined}
      loading={eager ? 'eager' : 'lazy'}
      draggable={false}
      style={{ display: 'block' }}
    />
  );
}
