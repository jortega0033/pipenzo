# Pipenzo asset manifest

Filename → intended usage map for the approved pack checked in at
`apps/desktop/assets/pipenzo/`. See [BRAND.md](BRAND.md) for the usage rules behind these
categories. The pack's own `manifest.json` (size + SHA-256 + dimensions per file) is the machine
source of truth; `pnpm assets:validate` fails if a file drifts from it.

## `brand/` — the functional mark

| File | Use |
|---|---|
| `pipenzo-helmet-p-glyph-black.svg` / `.png` | Helmet+`p` glyph, black, for light backgrounds |
| `pipenzo-helmet-p-glyph-white.svg` / `.png` | Helmet+`p` glyph, white, for dark backgrounds |
| `pipenzo-lockup-horizontal-dark.svg` / `-light.svg` | Icon + wordmark, side by side |
| `pipenzo-lockup-stacked-dark.svg` / `-light.svg` | Icon + wordmark, stacked |
| `pipenzo-wordmark-dark.svg` / `-light.svg` | Wordmark only |
| `pipenzo-patch-p.svg` | Small `p` patch mark |
| `pipenzo-favicon-{16,32,48,64}.png`, `favicon.ico` | Browser/site favicon sizes |

## `app-icons/` — native application icon

| File | Use |
|---|---|
| `pipenzo-app-icon-helmet-p-monochrome.svg` | Canonical deterministic source for `scripts/assets/generate_assets.py`'s Pipenzo icon family |
| `pipenzo-app-icon-helmet-p-monochrome[-inverted]-1024.png` | 1024px masters, black-on-white and white-on-black |
| `pipenzo.ico`, `pipenzo.icns` | Windows/macOS native icon containers |
| `png/pipenzo-icon-{16,20,24,32,48,64,128,256,512,1024}.png` | Production icon sizes |

## `mascot/detailed/` — canonical Field Engineer + role variants

Full illustrated character art, transparent PNG/WebP. `pipenzo-field-engineer-canonical-fullbody`
and `-canonical-bust` are the primary character reference. `neutral`, `working`/`terminal`,
`inspect`/`review`, `ready`, `refuse` are Field Engineer state art (some states intentionally share
the same file — see BRAND.md's role table). `commander-routing`, `recon-refine`,
`inspector-review`, `auditor-verify` are the other role/loadout variants.

## `mascot/mini/` — 32–512px portraits

`pipenzo-head-{alert,commander,focused,neutral,skeptical,thinking,waiting}-{32,48,64,96,128,256,512}.png`
(+ `.webp` at the larger sizes). Decorative/state indicators — phase badges, small status
portraits. Below 32px, use the `brand/` mark instead, not a mascot head.

## `mascot/sprites/` — 32–96px compact full-body states

`pipenzo-sprite-{idle,inspect,point,wait,walk,work}-{32,48,64,96}.png`. Compact full-body poses for
small in-app placements (e.g. a phase-progress strip).

## `illustrations/` — scene compositions

| File | Use |
|---|---|
| `pipenzo-first-run-empty-state-1200x760` | Large first-run/empty-board hero |
| `pipenzo-oversized-ticket-1600x900` | Refine refuses an oversized/underspecified ticket |
| `pipenzo-small-ticket-1200x800`, `-good-implementation-1200x800` | A ticket that fit cleanly |
| `pipenzo-review-process-1600x900`, `-review-complete-1200x800` | Deterministic gates + reviewer/verifier |
| `pipenzo-failed-review-1200x800`, `-rejected-approval-1200x800` | A gate or a human said no — neutral, not sad |
| `pipenzo-ready-for-approval-1200x800`, `-human-approval-boundary-1600x900` | The approval boundary — the signature "Pipenzo waits" state |
| `pipenzo-multiple-tickets-commander-1400x800` | Commander/operations, multiple concurrent tickets |
| `pipenzo-workflow-roles-1800x650` | The full Refine → Implement → Review → Verify → approve strip |

## `marketing/` — public/social compositions

| File | Use |
|---|---|
| `pipenzo-github-social-preview-{1200x630,1280x640}` | GitHub repo social preview + OG derivative ([#240](https://github.com/jortega0033/pipenzo/issues/240)) |
| `pipenzo-readme-hero-1600x520` | README hero |
| `pipenzo-landing-hero-1600x900` | Landing-page hero ([#245](https://github.com/jortega0033/pipenzo/issues/245)) |

## `reference/` — internal QA boards, not for shipping

Approved-system reference boards used during the pack's own review. Useful context for brand
audits; not meant to be surfaced on any product/public page.

## `docs/` — the pack's own provenance

`ASSET_INDEX.md`, `BRAND_USAGE.md`, `QA_REPORT.md`, and `qa-contact-*.jpg` are the pack's own
review record, carried over as-is for provenance. `BRAND.md` and this file are the repo's own
usage docs, layered on top.
