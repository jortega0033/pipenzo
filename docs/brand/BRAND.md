# Pipenzo brand & mascot usage

This records the usage rules the approved asset pack (`apps/desktop/assets/pipenzo/`, see
[ASSET_MANIFEST.md](ASSET_MANIFEST.md)) was reviewed against. Every surface that uses Pipenzo
artwork — desktop app, README, landing page, docs, releases — follows these rules rather than
reinterpreting the character independently.

## One character, many loadouts

The canonical Pipenzo mascot is the **Field Engineer**. Commander, Recon, Inspector, Auditor, and
Ready are **not separate mascots** — they're the same operator in a different job/loadout, used to
signal which phase of the workflow is active:

| Role variant | Workflow phase | Meaning |
|---|---|---|
| Field Engineer | Implement | The default, canonical identity |
| Recon | Refine | Scoping the ticket before code is written |
| Inspector | Review | Deterministic gates + LLM review |
| Auditor | Verify | Adversarial verification pass |
| Commander | Operations/routing | Model routing, retries, queue coordination — not the hero |
| Ready | Awaiting human command | The approval boundary (see below) |

Every variant keeps the same helmet, goggles, hair silhouette, face, headset, backpack, jacket,
boots, and `p` insignia. A reviewer should reject any integration where a role variant reads as an
unrelated character.

## Mark vs. mascot

Three distinct layers, and they don't substitute for each other:

1. **Helmet + `p` mark** (`brand/pipenzo-helmet-p-glyph-*.svg`, `app-icons/`) — the functional
   identity: app icon, favicon, installer, tiny navigation, any surface at 16–32px. The full
   mascot must **never** be used at these sizes.
2. **Mini portraits / sprites** (`mascot/mini/`, `mascot/sprites/`) — decorative or state
   indicators at roughly 32–96px (up to 512px for larger mini-portrait use). Recognizably the same
   operator, deliberately simplified.
3. **Detailed Field Engineer** (`mascot/detailed/`, `illustrations/`, `marketing/`) — README,
   landing pages, onboarding, large empty states, and social compositions.

SVG is for the functional mark/icon/wordmark/lockup layer only. Mascot characters are reviewed
PNG/WebP illustrations, never generic/generated SVG figures — see the epic
([#247](https://github.com/jortega0033/pipenzo/issues/247)) for why that's a hard rule, not a
style preference: a previous, rejected pass produced generic stickman art instead of using this
pack.

## The product story the mascot has to carry

Pipenzo delegates engineering work without delegating authority:
`Issue → Refine → Implement → Review → Verify → human decision`. The agent can work autonomously
inside its boundary; anything that leaves the machine waits for a person
(see the root [README.md](../../README.md#how-it-works)).

The single most important mascot state is not "coding" — it's **work is finished, Pipenzo is
standing beside the final control, and the human decides what happens next** (the approved
`illustrations/pipenzo-human-approval-boundary-*` / `illustrations/pipenzo-ready-for-approval-*`
scenes, and the `ready` mini/sprite states).

Non-negotiables for every integration:

- Never visually imply auto-publishing or auto-approval.
- Never celebrate before a human approves.
- Never use a sad/guilting mascot after a rejection — a rejection is a neutral, acknowledged
  outcome, not a failure state.
- Refusal (an oversized/underspecified ticket) is competence, not an error apology — use the
  approved refusal art, and keep the real estimate/threshold/split as the primary content next to
  it.

## UI restraint

- Never replace a semantic status/security/gate icon with a mascot expression.
- Never use the mascot as a loading spinner for long-running agent work.
- Keep mascot art out of credential/token-vault, OAuth-scope, security-warning,
  destructive-action-confirmation, and merge-conflict surfaces — clarity has to dominate there.
- Don't scatter mascot art across every banner, toast, event row, or empty lane. Use it at a small
  number of high-signal moments (see [#244](https://github.com/jortega0033/pipenzo/issues/244)).

## Palette

The richer khaki/bronze/red illustration palette belongs to the mascot artwork only. It is not
part of the audited application UI token palette — don't pull illustration colors into UI
components.

## Provenance

The pack was produced and QA'd outside this repository (197/197 checks passed — see
`apps/desktop/assets/pipenzo/docs/QA_REPORT.md`) and checked in as-is by
[#239](https://github.com/jortega0033/pipenzo/issues/239). `scripts/assets/validate_assets.py`
checks every file in the pack against its own `manifest.json` (size + SHA-256 + dimensions), so any
future accidental edit, redraw, or reinterpretation of the approved artwork fails CI rather than
silently drifting.
