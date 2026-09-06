import { Icon } from './Icon.js';

export type AvatarProps =
  | { variant?: 'human'; initials: string; label?: string }
  | { variant: 'agent'; label?: string };

/**
 * The two-variant avatar from Foundations.dc.html's "segmented switch · kbd · avatar" sample:
 * human (initials on plain surface-3) or agent (the accent-filled circle with the agent icon).
 * One size -- 32px, the only size the canvas shows. Decorative by default like everything else
 * in this system that sits next to a visible name; pass `label` when the avatar appears on its
 * own with nothing else identifying whose it is.
 */
export function Avatar(props: AvatarProps) {
  if (props.variant === 'agent') {
    return (
      <div
        className="avatar"
        style={{ background: 'var(--color-accent)', color: 'var(--color-accent-fg)' }}
        role={props.label ? 'img' : undefined}
        aria-label={props.label}
        aria-hidden={props.label ? undefined : true}
      >
        <Icon name="agent" />
      </div>
    );
  }
  return (
    <div className="avatar" role={props.label ? 'img' : undefined} aria-label={props.label} aria-hidden={props.label ? undefined : true}>
      {props.initials}
    </div>
  );
}
