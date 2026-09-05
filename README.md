# Pipenzo

Open-source Electron desktop app that turns a GitHub issue into an agent-implemented, human-approved pull request. Point it at a repo, click **Implement** on an issue, and an autonomous agent loop (refine → implement → review) does the work — landing as a small, reviewable PR, never pushed without your say-so.

No monetization plan. This is a portfolio / open-source project, built on the same foundations as [agentdock](https://github.com/jortega0033/agentdock).

Status: pre-implementation. This repo currently holds the product research, architecture decisions, and a clickable design canvas — no app code yet.

## Why this exists, and why it's honest about its limits

Autonomous issue-to-PR agents are a crowded, mixed-results category: published PR acceptance rates for agentic PRs sit around 55% vs. 82.6% for humans across ~930K PRs studied, and several direct competitors (Sweep, Terragon, Bloop, Vibe Kanban, Roo Code) have shut down or been discontinued. Pipenzo doesn't pretend otherwise — it exists to explore the problem properly (small PRs by construction, honest review gates, no fabricated evidence) rather than to out-market that category. See [`docs/research-report.html`](docs/research-report.html) for the full competitive/technical research this is built on (landscape, stack choices, model routing, PR-size strategy, feature plan, build order — ten research passes against primary sources).

## How it works

**Plan → Refine → Implement → Review**

1. **Plan** *(optional entry point)* — no issue yet? A conversational agent turns a rough idea into a real GitHub issue: describe the problem in plain language, the agent asks clarifying questions, drafts the issue, creates it on confirmation. This is also the on-ramp for non-developers who've never written an issue.
2. **Refine** — a read-only subagent (`Read`/`Grep`/`Glob` only, cannot write) turns the issue into a structured spec: acceptance criteria in EARS notation, an explicit out-of-scope list, files likely touched, and a self-estimated diff size. Missing info or an oversized ticket stops here and asks a human, while it's still cheap.
3. **Implement** — a fresh session seeded only with the spec plus symbol-graph context (not raw file search). Retries use `session.fork` to keep spec context and audit lineage intact, never a brand-new run.
4. **Review** — deterministic gates first (build/typecheck, spec-generated tests the implementer never wrote itself, gitleaks, Semgrep, a diff-scope check against the Phase-1 estimate). Only then an LLM review pass in a fresh session seeing just the spec and the diff, followed by a separate adversarial verifier — always at the same model tier or higher than the implementer, never a weaker model reviewing a stronger one.

Nothing is pushed or opened as a PR without an explicit human approval step — see **Autonomy & the publish gate** in the research report.

## Model routing

Task tiers (`refine` / `implement-small` / `implement-standard` / `implement-hard` / `review` / `verify`) route to different model strengths, with a hard rule: the adversarial verifier is never a weaker tier than the implementer it's checking, and cross-vendor review is used only as a tiebreaker among equal tiers. Retries escalate tier before they escalate to a human, capped attempts throughout — no unbounded retry loop.

## Small PRs, by construction

- ≤ 100 lines / ≤ 10 files → implement as one PR.
- 100–400 lines, layered → refuse to start until the agent has written down a dependency-ordered stack of 2–4 independently-buildable PRs.
- \> 500 additions, > 20 files, or no clean layering → don't implement; flag `needs-pre-scoping`, post the estimate and proposed split as a comment, hand it to a human.

This gate runs at Refine, before any code is written.

## Feature plan (from the research report)

**MVP**
- Kanban home: Queued / Working / Ready-for-review lanes, backed by GitHub labels as the state model (survives app restart, no separate source of truth)
- Implement dialog with optional prompt + branch override — never a bare button
- Plan phase / "New from idea" conversational issue creation
- Agent-state enum with an OS notification exactly on "awaiting input"
- Inline approval cards with a reject-reason field
- Separate "Push branch" / "Push & open PR" buttons
- Verification-evidence block in the PR body, self-reported evidence flagged as such
- Subscription-headroom rail — not a fake dollar figure
- Per-ticket token/run budget (0 = unlimited)
- Classified retry — never auto-retries a denied approval
- Park after 3 consecutive failures → a "needs human" lane
- Diff-size gate at refine, with a proposed PR-stack split
- Simple mode by default, expert mode persisted per user

**Later**
- Reviewer-grade diff layout with a findings sidebar by severity
- Plan-review gate before implementation starts
- Steer mid-run; Stop preserves commits
- PR-event reactions (CI failure, merge conflict)
- Local, human-gated lesson memory

## Stack

| Concern | Choice | Why |
|---|---|---|
| UI components | shadcn/ui + Tailwind v4 | Component source you own and restructure per audience; coexists with a screen-by-screen migration |
| Kanban board | dnd-kit | Standard pairing with shadcn; shadcn has no kanban primitive |
| Diff review | react-diff-view | Parses real unified diffs into collapsible hunks — tens of kB, not Monaco's multi-MB editor |
| GitHub API client | `@octokit/core` + `paginate-rest` | Not the octokit metapackage, not the `gh` binary — pure JS, tree-shaken into the daemon bundle |
| GitHub OAuth | `@octokit/auth-oauth-device` | Device flow — no client secret to embed in a shipped OSS binary, no loopback listener |
| Git operations | `execFile('git', …)` | Same trust model as agentdock's worktree manager — argv array, `shell:false`, sanitized env |
| Notifications | Electron `Notification` API | Native, cross-platform, already solves this |
| Ticket/queue store | JSON file store | Matches agentdock's `FileSessionStore` pattern; no native-addon DB needed for hundreds of rows |

Full rationale for each choice is in the research report.

## Design

A clickable Claude Design canvas covers the product's key screens: kanban home (sidebar + main-content admin layout), live ticket progress with phase stepper and model-routing/budget rail, inline approval, a reviewer-grade diff view, and a plain-language "Simple mode" view for non-developer users. Dark-mode only for now — light mode is a stated roadmap item, not built yet.

- [`design/pipenzo-prototype.html`](design/pipenzo-prototype.html) — the full seeded canvas, open directly in a browser
- [`design/artboards/`](design/artboards/) — the individual screens as editable `.dc.html` source (`Foundations` = design-system/primitives reference; `Main`, `TicketDetail`, `ApprovalPrompt`, `DiffReview`, `SimpleMode` = product screens)
- [`design/canvas.json`](design/canvas.json) — canvas layout manifest
- Icons: [Phosphor Icons](https://phosphoricons.com/) (regular weight), inlined as SVG
- Typography: IBM Plex Sans + IBM Plex Mono

## Build order

1. Design system, before any screen — shadcn/ui primitives, tokens, branding. Everything else builds against this.
2. Walking skeleton — hardcoded repo, PAT from env, no queue. One ticket through refine → implement → review → diff screen → open PR, end to end.
3. Ticket store + phase machine — JSON-file persistence, crash recovery, phase-change SSE, a real ticket detail view.
4. GitHub & the size gate, properly — device-flow OAuth in Electron main, token vault, real issue list, the diff-size/split gate enforced at refine, a test asserting the token never reaches a provider subprocess.
5. Queue + dual-audience mode — dnd-kit kanban, simple/expert toggle with a persisted default, one worktree per ticket.
6. Polish — native "awaiting approval" notification, rejection loop that forks implementation again, dirty-worktree discard path, an audit entry for every publish and review-gate result.

**Biggest risk called out in the research:** the temptation in step 2 to let the agent shell out to `gh` directly. Publishing stays outside the agent loop from the first commit — retrofitting that boundary later breaks the safety property the whole design depends on.

## Naming

Named after the product owner's two kids — decided over every researched alternative on that basis alone.

## License

TBD (open source).
