import type { ReactNode } from 'react';
import type { WORKFLOW_STEPS } from '../content.js';

type Role = (typeof WORKFLOW_STEPS)[number]['role'];

/**
 * One line glyph per phase, drawn for small sizes. The mascot masters are near-identical poses
 * at 64px (Refine and Implement share a pose, as do Review and Verify), so the phases are told
 * apart by what each one produces instead: a spec, a diff, a gate list, a second look, a person.
 * Always decorative: the phase name sits next to it as real text.
 */
export function PhaseGlyph({ role, className = '' }: { role: Role; className?: string }) {
  return (
    <svg
      viewBox="0 0 40 40"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      {GLYPHS[role]}
    </svg>
  );
}

const GLYPHS: Record<Role, ReactNode> = {
  // Refine: a spec document with its criteria ticked off.
  recon: (
    <>
      <path d="M11 5h13l7 7v22a2 2 0 0 1-2 2H11a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z" />
      <path d="M24 5v7h7" />
      <path d="M13.5 19.5l1.5 1.5 3-3" />
      <path d="M21 20h6" />
      <path d="M13.5 27.5l1.5 1.5 3-3" />
      <path d="M21 28h6" />
    </>
  ),
  // Implement: a diff, one line added and one removed, between code brackets.
  engineer: (
    <>
      <path d="M12 11l-7 9 7 9" />
      <path d="M28 11l7 9-7 9" />
      <path d="M20 12.5v7" />
      <path d="M16.5 16h7" />
      <path d="M16.5 25.5h7" />
    </>
  ),
  // Review: a gate list, each check passing in order.
  inspector: (
    <>
      <rect x="6" y="6" width="28" height="28" rx="3" />
      <path d="M11 13.5l1.5 1.5 3-3" />
      <path d="M19 14h10" />
      <path d="M11 20.5l1.5 1.5 3-3" />
      <path d="M19 21h10" />
      <path d="M11 27.5l1.5 1.5 3-3" />
      <path d="M19 28h10" />
    </>
  ),
  // Verify: a reticle, the adversarial second look.
  auditor: (
    <>
      <circle cx="20" cy="20" r="11" />
      <path d="M20 4v6" />
      <path d="M20 30v6" />
      <path d="M4 20h6" />
      <path d="M30 20h6" />
      <path d="M15.5 20.5l3 3 6-6.5" />
    </>
  ),
  // You approve: a person.
  ready: (
    <>
      <circle cx="20" cy="14" r="5.5" />
      <path d="M9 34c0-6.5 4.9-11 11-11s11 4.5 11 11" />
    </>
  ),
};
